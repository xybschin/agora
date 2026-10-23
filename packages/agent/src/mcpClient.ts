/**
 * The agent side of the Run's room: the MCP connection to mcp_server, wrapped
 * as the room's operations rather than as a tool-call pipe. The agent loop
 * (loop.ts) and the Moderator (moderator.ts) read the room, send a Reply or a
 * Room post, react, and wait for activity through this module; neither knows an
 * MCP tool name and neither parses a tool result.
 *
 * The one place a room operation is mapped to its catalog name is TOOL_KINDS
 * below. The specs advertised to the model still come from the shared
 * matrixToolCatalog, so the server and the client cannot drift, and the
 * runtime-only long-poll is filtered out of them (offered a blocking wait, the
 * model could pin a turn indefinitely).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { matrixToolCatalog, matrixWaitForActivityTool } from "@agora/shared";
import type { ToolSpec } from "./llm.js";

/** One message as matrix_read_room returns it, oldest first. */
export interface RoomMessage {
  eventId: string;
  sender: string;
  /** Display name if the server could resolve it; otherwise the raw user id. */
  senderDisplayName: string;
  /** The message body. A Reply's fallback quote is already stripped. */
  content: string;
  /** Set when the message is a Reply (it carries an m.in_reply_to relation). */
  replyTo?: ReplyTarget;
  /** ISO timestamp, from the homeserver's origin_server_ts. */
  createdAt: string;
}

/** The message a Reply answers, as far as the Reply itself tells us. */
export interface ReplyTarget {
  eventId: string;
  senderDisplayName?: string;
  /** The start of the target's text, cut from the Reply's fallback quote. */
  excerpt?: string;
}

/** A message that reached the room. */
export interface SentMessage {
  id: string;
  createdAt: string;
}

/** The result of a Room post. */
export type PostOutcome =
  | { kind: "sent"; message: SentMessage }
  /**
   * The room accepted the send but the result was not a SentMessage envelope.
   * The message is in the room, so the caller must treat it as posted and must
   * not retry; it is still a failure worth surfacing.
   */
  | { kind: "unreadable"; raw: string };

/** The result of a Reply: a send, a refusal before sending, or an unreadable send. */
export type ReplyOutcome = PostOutcome | { kind: "rejected"; reason: string };

/** The result of a reaction: accepted, or the server's error text. */
export type ReactionOutcome = { kind: "done" } | { kind: "failed"; reason: string };

/** The room operations a model-facing MCP tool can reach. */
export type RoomToolKind = "read" | "reply" | "post" | "reaction";

/**
 * The single mapping from a catalog tool name to a room operation. The names
 * are literals here and nowhere else in the agent: a runtime asks
 * `roomToolKind(call.function.name)` instead of comparing against tool names,
 * and listToolSpecs derives what the model may call from the same map.
 */
const TOOL_KINDS: Readonly<Record<string, RoomToolKind>> = {
  matrix_read_room: "read",
  matrix_reply: "reply",
  matrix_post: "post",
  matrix_add_reaction: "reaction",
};

/** Which room operation a model-named MCP tool is, if any. */
export function roomToolKind(name: string): RoomToolKind | undefined {
  // The name comes from the model, so it can be "constructor" or "toString";
  // only the map's own keys are tools.
  return Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name] : undefined;
}

/** The schema's cap, and the default when the model does not name a limit. */
const MAX_READ_LIMIT = 100;
const DEFAULT_READ_LIMIT = 20;

function normalizeReadLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_READ_LIMIT;
  return Math.max(1, Math.min(MAX_READ_LIMIT, Math.trunc(limit)));
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asSentMessage(parsed: unknown): SentMessage | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { id, createdAt } = parsed as { id?: unknown; createdAt?: unknown };
  if (typeof id !== "string" || typeof createdAt !== "string") return undefined;
  return { id, createdAt };
}

function asRejection(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { rejected } = parsed as { rejected?: unknown };
  return typeof rejected === "string" ? rejected : undefined;
}

/**
 * Calls one MCP tool and returns its first text part, or the whole result as
 * JSON when it has none. A tool-level error result comes back as text like any
 * other; only a client/transport failure throws, wrapped with the tool's name.
 *
 * This is the transport seam, not the client's interface: everything below it
 * is typed, everything above it is a room operation.
 */
export type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

/** The production transport: one MCP connection, authenticated as this agent. */
export function createMcpCallTool(mcpUrl: string, accessToken: string): CallTool {
  const client = new Client({ name: "agora-agent", version: "0.1.0" });
  let connecting: Promise<void> | undefined;

  const connect = (): Promise<void> => {
    connecting ??= client
      .connect(
        new StreamableHTTPClientTransport(new URL(mcpUrl), {
          // The token is the only identity sent: the server resolves who the
          // caller is from it (GET /account/whoami), so there is no user-id
          // header for a client to assert (agora-2ja).
          requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
          fetch: fetch,
        }),
      )
      // A failed connect must not be cached: the next call retries instead of
      // inheriting the rejected promise for the rest of the Run.
      .catch((error) => {
        connecting = undefined;
        throw error;
      });
    return connecting;
  };

  return async (name, args) => {
    await connect();
    try {
      const result = await client.callTool({ name, arguments: args });
      if (!Array.isArray(result.content)) return JSON.stringify(result);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (part) => part.type === "text",
      )?.text;
      return text ?? JSON.stringify(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP tool call failed for ${name}: ${errorMessage}`);
    }
  };
}

/**
 * The room's operations, over one agent's MCP connection.
 *
 * Each method owns the tool name, the argument encoding and the result shape,
 * so a caller never sees the transport. Sends distinguish a refusal (nothing
 * reached the room), a send, and an accepted-but-unreadable send: the last is
 * still a send, and exists so a failed Turn is never re-run into a second post.
 */
export class MatrixMcpClient {
  private readonly call: CallTool;

  constructor(
    mcpUrl: string,
    accessToken: string,
    /**
     * Injected only so tests can answer tool calls without a homeserver; the
     * production path builds the MCP transport from the URL and token.
     */
    callTool: CallTool = createMcpCallTool(mcpUrl, accessToken),
  ) {
    this.call = callTool;
  }

  /**
   * The tool specs the model may call, derived from the shared catalog. The
   * runtime-only long-poll is always excluded; `exclude` withholds further
   * operations by kind (the Moderator never offers Reply, ADR-0010).
   */
  listToolSpecs(options: { exclude?: readonly RoomToolKind[] } = {}): ToolSpec[] {
    const exclude = options.exclude ?? [];
    return matrixToolCatalog
      .filter(({ name }) => name !== matrixWaitForActivityTool)
      .filter(({ name }) => {
        const kind = roomToolKind(name);
        // A catalog tool without a room operation would be advertised but
        // undispatchable; fail loudly rather than let the two drift.
        if (kind === undefined) throw new Error(`catalog tool '${name}' has no room operation`);
        return !exclude.includes(kind);
      })
      .map(({ name, description, schema }) => ({
        type: "function" as const,
        function: {
          name,
          description,
          parameters: schema.toJSONSchema(),
        },
      }));
  }

  /**
   * Reads the most recent messages, oldest first. The limit is clamped to the
   * tool's accepted range so a malformed model argument cannot fail the read.
   * Throws when the room could not be read; the caller decides whether that is
   * a best-effort count (null) or a failed Turn.
   */
  async readRoom(limit?: number): Promise<RoomMessage[]> {
    const raw = await this.call("matrix_read_room", { limit: normalizeReadLimit(limit) });
    const parsed = tryParse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`matrix_read_room did not return a message list: ${raw}`);
    }
    return parsed as RoomMessage[];
  }

  /**
   * Sends a Room post. The room is fixed by the server's environment, so there
   * is nothing to choose and nothing to pass: `content` is the whole message.
   */
  async post(content: string): Promise<PostOutcome> {
    const raw = await this.call("matrix_post", { content });
    const parsed = tryParse(raw);
    const message = asSentMessage(parsed);
    return message ? { kind: "sent", message } : { kind: "unreadable", raw };
  }

  /**
   * Sends a Reply to `eventId`. A target the server refuses comes back as an
   * ordinary rejection (ADR-0010), not a throw, so the Turn can hand the reason
   * to the model and let it retry within the turn.
   */
  async reply(eventId: string, content: string): Promise<ReplyOutcome> {
    const raw = await this.call("matrix_reply", { eventId, content });
    const parsed = tryParse(raw);
    const rejection = asRejection(parsed);
    if (rejection !== undefined) return { kind: "rejected", reason: rejection };
    const message = asSentMessage(parsed);
    return message ? { kind: "sent", message } : { kind: "unreadable", raw };
  }

  /**
   * Reacts to one event with an emoji. A tool-level failure comes back as the
   * server's error text, not a throw, so it is returned for the model to see
   * rather than reported as success.
   */
  async addReaction(eventId: string, reaction: string): Promise<ReactionOutcome> {
    const raw = await this.call("matrix_add_reaction", { eventId, reaction });
    return raw === "ok" ? { kind: "done" } : { kind: "failed", reason: raw };
  }

  /**
   * Long-polls the room for new activity via the matrix_wait_for_activity tool
   * (the one tool the model never sees). Blocks up to `timeoutMs`; returns
   * whether anything new arrived and the `nextBatch` resume token to pass as
   * `since` on the next wait. A timed-out wait with nothing new is a normal,
   * non-error result (`hasActivity: false`). A client/transport failure throws
   * and is the caller's to recover from — the loop treats it as transient.
   */
  async waitForActivity(args: {
    timeoutMs: number;
    since?: string;
  }): Promise<{ hasActivity: boolean; nextBatch: string }> {
    const raw = await this.call(matrixWaitForActivityTool, {
      timeoutMs: args.timeoutMs,
      since: args.since,
    });
    const parsed = JSON.parse(raw) as { hasActivity?: boolean; nextBatch?: string };
    return {
      hasActivity: parsed.hasActivity === true,
      nextBatch: parsed.nextBatch ?? "",
    };
  }
}
