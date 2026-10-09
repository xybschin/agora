// matrixActions.ts
//
// The Matrix Client-Server API calls behind the MCP tools that index.ts
// registers. Each tool maps onto one primary CS-API call:
//
//   matrix_read_room          GET /_matrix/client/v3/rooms/{id}/messages?dir=b
//   matrix_reply, matrix_post PUT /_matrix/client/v3/rooms/{id}/send/m.room.message/{txnId}
//   matrix_add_reaction       PUT /_matrix/client/v3/rooms/{id}/send/m.reaction/{txnId}
//   matrix_wait_for_activity  GET /_matrix/client/v3/sync (long-poll)
//
// plus supporting reads: /account/whoami (who the caller is), /joined_members
// (display names), and /rooms/{id}/event/{eventId} (reply quotes).
//
// Requests go through raw fetch rather than matrix-js-sdk. That keeps the
// tools minimal, keeps the heavy SDK (and its crypto/olm dependencies) out of
// the MCP server, and gives full control of the request and response shapes.
//
// Every function takes the room id from its caller, which in turn takes it
// from MATRIX_ROOM_ID, never from a model-supplied tool argument.
import type { MatrixClient } from "./matrixPool.js";

export interface RoomMessage {
  eventId: string;
  sender: string;
  /** Display name if we can cheaply resolve it; otherwise the raw user ID. */
  senderDisplayName: string;
  /**
   * The message body (m.text / m.notice / fallback for other types). May be
   * prefixed with "**your message:**" if sent by the caller. A Reply's
   * rich-reply fallback quote is stripped; `replyTo` describes its target.
   */
  content: string;
  /** Set when the message is a Reply (carries an m.in_reply_to relation). */
  replyTo?: ReplyTarget;
  /** ISO timestamp, from origin_server_ts (epoch millis). */
  createdAt: string;
}

/** The message a Reply answers, as far as the Reply itself tells us. */
export interface ReplyTarget {
  eventId: string;
  /**
   * The target's sender, named like `senderDisplayName`. Omitted only when the
   * Reply carries no fallback quote to read the sender from.
   */
  senderDisplayName?: string;
  /**
   * The start of the target's text, cut from the Reply's fallback quote and
   * truncated to REPLY_EXCERPT_MAX_CHARS. Omitted when there is no fallback.
   */
  excerpt?: string;
}

/** Longest replyTo.excerpt, in characters, including the trailing ellipsis. */
const REPLY_EXCERPT_MAX_CHARS = 80;

interface RawEvent {
  event_id: string;
  sender: string;
  type: string;
  content: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: {
      "m.in_reply_to"?: { event_id?: string };
      rel_type?: string;
      event_id?: string;
      key?: string;
    };
  };
  origin_server_ts?: number;
}

const CLIENT_PREFIX = "/_matrix/client/v3";

/**
 * Sends one authenticated CS-API request as the client's token and returns the
 * parsed JSON body. Throws on any non-2xx status, with the homeserver's
 * response text in the message.
 */
async function csRequest<T>(
  client: MatrixClient,
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${client.homeServerUrl}${CLIENT_PREFIX}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Matrix API ${method} ${path} failed (${response.status}): ${text}`);
  }
  // Parsed unconditionally: every endpoint called here answers success with a
  // JSON object, so an empty body would be a homeserver fault and throws here.
  return (await response.json()) as T;
}

/**
 * Resolve the caller's own user id from their access token, not from anything a
 * client asserts. readRoom needs to know which messages are the agent's own, and
 * the only trustworthy source of that is the homeserver's answer for the token
 * (GET /account/whoami): an access token is what Matrix binds identity to, and a
 * client-supplied id can be forged, so `readRoom` resolves it here rather than
 * taking it as a parameter. This is the guarantee that one agent can never have
 * another's messages marked as its own, or its own marked as someone else's.
 */
export async function resolveOwnUserId(client: MatrixClient): Promise<string> {
  const data = await csRequest<{ user_id?: string }>(client, "GET", "/account/whoami");
  if (!data.user_id) {
    throw new Error("Matrix GET /account/whoami returned no user_id");
  }
  return data.user_id;
}

/**
 * Reads the most recent messages and reactions in a room, returned oldest
 * first. `limit` goes straight to the homeserver as the number of events to
 * fetch, and reactions count against it.
 *
 * The caller's own events have their `content` prefixed with
 * "**your message:**", which the agent's system prompt (persona.ts) tells it
 * to look for. A Reply's fallback quote is replaced by `replyTo`, built from
 * the quote itself (see parseReplyFallback). Makes three requests: /messages, /joined_members for display
 * names, and /account/whoami to learn who the caller is.
 */
export async function readRoom(
  client: MatrixClient,
  roomId: string,
  limit: number,
): Promise<RoomMessage[]> {
  const params = new URLSearchParams({
    dir: "b", // backward: newest first
    limit: String(limit),
    filter: JSON.stringify({ types: ["m.room.message", "m.reaction"] }),
  });
  const data = await csRequest<{ chunk?: RawEvent[] }>(
    client,
    "GET",
    `/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
  );

  // The member list is only used to name senders and is never returned, so
  // it does not become the member-list tool that ADR-0003 relies on agents
  // lacking: a Reader who never speaks never shows up in a read.
  let memberMap: Record<string, string> = {};
  try {
    // /joined_members returns a flat member object per user ({ display_name,
    // avatar_url }) — not the state-event `content` shape — so read the flat
    // display_name field. See agora-ber.
    const membersData = await csRequest<{ joined: Record<string, { display_name?: string }> }>(
      client,
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    for (const [userId, member] of Object.entries(membersData.joined ?? {})) {
      memberMap[userId] = member.display_name ?? userId;
    }
  } catch {
    // Display names are cosmetic, so a failed lookup should not fail the
    // read; senders fall back to their raw user IDs.
  }

  // Identity comes from the token, never from a client-supplied value, so own
  // messages are recognised by who the homeserver says the token belongs to.
  const ownMatrixUserId = await resolveOwnUserId(client);

  const messages = (data.chunk ?? [])
    .filter((event) => {
      if (event.type === "m.room.message") return true;
      // Reactions are kept as a lightweight agree/disagree signal.
      if (event.type === "m.reaction") return true;
      return false;
    })
    .reverse(); // dir=b is newest-first; flip to oldest-first like the read tool promises.

  return messages.map((event) => {
    const replyToEventId = event.content?.["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    const isOwnMessage = ownMatrixUserId && event.sender === ownMatrixUserId;
    let content = summaryText(event);
    let replyTo: ReplyTarget | undefined;
    if (replyToEventId) {
      // With most messages Replies, the full fallback quote would roughly
      // double every read (ADR-0010), so it is swapped for a short excerpt.
      // Only this read is compacted; the room keeps the quote for Readers.
      replyTo = { eventId: replyToEventId };
      const fallback = parseReplyFallback(content);
      if (fallback) {
        content = fallback.reply;
        replyTo.senderDisplayName = memberMap[fallback.sender] ?? fallback.sender;
        replyTo.excerpt = fallback.excerpt;
      }
    }
    if (isOwnMessage) {
      content = `**your message:** ${content}`;
    }
    return {
      eventId: event.event_id,
      sender: event.sender,
      senderDisplayName: memberMap[event.sender] ?? event.sender,
      content,
      ...(replyTo ? { replyTo } : {}),
      createdAt: new Date(event.origin_server_ts ?? Date.now()).toISOString(),
    };
  });
}

/**
 * Splits a Reply's body into its rich-reply fallback quote and the reply
 * itself. The fallback is the run of leading ">" lines, opening with the
 * original sender in angle brackets: on a line of its own as replyFallback
 * writes it ("> <@bob:hs>"), or ahead of the original's first line as other
 * clients write it ("> <@bob:hs> first line"). The excerpt is the quoted
 * original joined onto one line and cut to REPLY_EXCERPT_MAX_CHARS. A body
 * that does not open that way has no fallback and yields undefined.
 */
export function parseReplyFallback(
  body: string,
): { sender: string; excerpt: string; reply: string } | undefined {
  const lines = body.split("\n");
  const header = /^> <(@[^>]+)>(?: (.*))?$/.exec(lines[0] ?? "");
  if (!header) return undefined;

  let end = 1;
  while (end < lines.length && lines[end]!.startsWith(">")) end++;
  // The fallback is separated from the reply by one blank line.
  const rest = lines.slice(end);
  if (rest[0] === "") rest.shift();

  const quoted = [header[2] ?? "", ...lines.slice(1, end).map((line) => line.replace(/^> ?/, ""))];
  const original = quoted.join(" ").replace(/\s+/g, " ").trim();
  const excerpt =
    original.length > REPLY_EXCERPT_MAX_CHARS
      ? `${original.slice(0, REPLY_EXCERPT_MAX_CHARS - 1).trimEnd()}…`
      : original;

  return { sender: header[1]!, excerpt, reply: rest.join("\n") };
}

function summaryText(event: RawEvent): string {
  const content = event.content ?? {};
  if (event.type === "m.reaction") {
    const key = content["m.relates_to"]?.key ?? "";
    return `[reaction] ${key}`;
  }
  return content.body ?? `[${event.type}]`;
}

function txnId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Strips a leading reply quote from a message, the kind agents copy from what
 * readRoom shows them when they reply. sendMessage builds its own fallback
 * quote for a rich reply, so a quote the agent wrote would appear twice.
 * Only a message starting with "> <@" and containing a blank line is touched;
 * everything up to the first blank line is dropped. Anything else is returned
 * unchanged.
 */
export function stripQuote(content: string): string {
  if (content.startsWith("> <@")) {
    const parts = content.split("\n\n");
    if (parts.length > 1) {
      return parts.slice(1).join("\n\n");
    }
  }
  return content;
}

/**
 * Build the plain-text fallback for a rich reply, per the Matrix "Rich replies"
 * convention: the `body` starts with the original event quoted sender-prefixed.
 * Clients that cannot render the `m.in_reply_to` relation fall back to this
 * text, so it should be the original message, not a placeholder. Returns
 * undefined when no quote can be produced (original has no body), in which case
 * the relation alone still carries the reply.
 */
async function replyFallback(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<string | undefined> {
  try {
    const original = await csRequest<{
      sender?: string;
      content?: { body?: string };
    }>(client, "GET", `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
    const originalBody = original.content?.body;
    if (!originalBody) return undefined;
    // Each line of the quoted original is prefixed with "> ", with an empty
    // quote line ("> ") before the reply itself, as the spec's fallback does.
    const quoted = originalBody
      .split("\n")
      .map((line) => (line.length > 0 ? `> ${line}` : `> `))
      .join("\n");
    return `> <${original.sender ?? "?"}>\n${quoted}`;
  } catch {
    // Don't block a send on quote-fetch failure; the relation is what matters.
    return undefined;
  }
}

/**
 * Sends an m.text message to a room, optionally as a rich reply to
 * `replyToEventId`. A reply costs an extra request to fetch the original for
 * its quote. `createdAt` in the result is this server's clock at send time,
 * not the homeserver's origin_server_ts.
 */
export async function sendMessage(
  client: MatrixClient,
  roomId: string,
  content: string,
  replyToEventId?: string,
): Promise<{ id: string; createdAt: string }> {
  let body: Record<string, unknown> = {
    msgtype: "m.text",
    body: content,
  };
  if (replyToEventId) {
    // Drop any quote the agent wrote itself; replyFallback supplies the real
    // one below.
    const cleanContent = stripQuote(content);
    body = {
      msgtype: "m.text",
      body: cleanContent,
      "m.relates_to": {
        // The relation is what makes this a reply; the quote added to `body`
        // below only serves clients that don't render the relation.
        "m.in_reply_to": { event_id: replyToEventId },
      },
    };
    // Wrap the body per the "Rich replies" quoting convention: quote the
    // original message (fetched by id) rather than a "<no-fallback>" stub, so
    // the reply reads correctly in any client that shows the fallback text.
    const fallback = await replyFallback(client, roomId, replyToEventId);
    if (fallback) {
      body["body"] = `${fallback}\n\n${cleanContent}`;
    }
  }
  const sent = await csRequest<{ event_id: string }>(
    client,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId()}`,
    body,
  );
  return { id: sent.event_id, createdAt: new Date().toISOString() };
}

/** Reacts to an event with an emoji (an m.annotation on the target event). */
export async function addReaction(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  reaction: string,
): Promise<void> {
  await csRequest(
    client,
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId()}`,
    {
      "m.relates_to": {
        rel_type: "m.annotation",
        event_id: eventId,
        key: reaction,
      },
    },
  );
}

export interface WaitForActivityResult {
  /** True if new room activity (a message or reaction) arrived during the wait. */
  hasActivity: boolean;
  /** Resume token (`next_batch`) to pass as `since` on the next wait. */
  nextBatch: string;
}

/**
 * Long-polls the room for new activity via the Matrix Client-Server /sync
 * endpoint (the CS-API's native long-poll), waking as soon as a message or
 * reaction lands or the bounded timeout elapses. The `timeout` query param
 * tells the homeserver to hold the response open; `since` is a `next_batch`
 * resume token so a later wait starts where this one left off instead of
 * re-reading the whole room.
 *
 * The filter restricts the timeline to the same event types the read tool
 * surfaces (`m.room.message`, `m.reaction`), so "new activity" means exactly
 * what the agent would act on and ignores state noise. `hasActivity` is true
 * whenever such a timeline event arrived. A wait that times out with nothing
 * new is a normal success: it returns `hasActivity: false`, not an error — the
 * loop just goes back to waiting.
 *
 * Without `since`, the request is an initial sync, which homeservers answer
 * at once with the room's recent timeline, so a first wait in a room that
 * already has messages reports activity immediately. If the response carries
 * no `next_batch`, the old `since` (or "") is returned so the caller can keep
 * looping.
 *
 * `roomId` comes from the server's bound MATRIX_ROOM_ID (the handler resolves
 * it from the environment), never from a model-supplied tool argument. It is
 * used only to pick this room out of the sync response: /sync itself is not
 * room-scoped, so the room id never goes over the wire.
 */
export async function waitForActivity(
  client: MatrixClient,
  roomId: string,
  timeoutMs: number,
  since?: string,
): Promise<WaitForActivityResult> {
  const params = new URLSearchParams({
    timeout: String(timeoutMs),
    filter: JSON.stringify({
      room: { timeline: { types: ["m.room.message", "m.reaction"] } },
    }),
  });
  if (since) params.set("since", since);

  const data = await csRequest<{
    next_batch?: string;
    rooms?: { join?: Record<string, { timeline?: { events?: unknown[] } }> };
  }>(client, "GET", `/sync?${params.toString()}`);

  const events = data.rooms?.join?.[roomId]?.timeline?.events ?? [];
  return {
    hasActivity: events.length > 0,
    nextBatch: data.next_batch ?? (since ?? ""),
  };
}
