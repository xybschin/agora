import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { matrixToolCatalog } from "@agora/shared";
import { getMatrixClient } from "./matrixPool.js";
import { readRoom, sendMessage, addReaction } from "./matrixActions.js";

const app = express();
app.use(express.json());

function extractAccessToken(req: express.Request): string {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new Error("Missing 'Authorization: Bearer <matrix-access-token>' header");
  }
  return header.slice("Bearer ".length);
}

function extractMatrixUserId(req: express.Request): string | undefined {
  return req.header("x-matrix-user-id");
}

/**
 * The one room this server ever talks to, read per request so an operator who
 * fixes the variable is fixed for the next tool call, with no restart.
 *
 * Required, with no default, for the same reason MATRIX_HOME_SERVER_URL is: it
 * is the difference between an agent posting in the room the Run created and an
 * agent posting in whatever room id a model felt like writing down. Compose
 * always sets it, so this only fires when the server runs outside compose --
 * exactly when guessing would be least excusable.
 */
function runRoomId(): string {
  const roomId = process.env.MATRIX_ROOM_ID;
  if (!roomId) {
    throw new Error(
      "Missing MATRIX_ROOM_ID: this server only ever speaks for the room its Run created, and it is told which rather than asked",
    );
  }
  return roomId;
}

/**
 * Builds a fresh McpServer per request, closing over the caller's access
 * token. Identity is bound to the session (Q7 of the design): tools take no
 * agent_id parameter, so one agent can never act as another Matrix user. The
 * room is bound the same way, from the environment rather than the tool call.
 */
function buildServer(accessToken: string, matrixUserId?: string): McpServer {
  const server = new McpServer({ name: "agora-matrix-mcp", version: "0.1.0" });
  const roomId = runRoomId();

  // One handler per tool, keyed by the catalog name. Each closes over the
  // caller's token, room, and user id, so identity and room stay bound to the
  // session (Q7 of the design): tools take no agent_id or room_id parameter.
  const handlers: Record<
    string,
    (args: any) => CallToolResult | Promise<CallToolResult>
  > = {
    matrix_read_room: async ({ limit }) => {
      const client = getMatrixClient(accessToken);
      const messages = await readRoom(client, roomId, limit, matrixUserId);
      return { content: [{ type: "text", text: JSON.stringify(messages) }] };
    },
    matrix_send_message: async ({ content, replyToEventId }) => {
      const client = getMatrixClient(accessToken);
      const sent = await sendMessage(client, roomId, content, replyToEventId);
      return { content: [{ type: "text", text: JSON.stringify(sent) }] };
    },
    matrix_add_reaction: async ({ eventId, reaction }) => {
      const client = getMatrixClient(accessToken);
      await addReaction(client, roomId, eventId, reaction);
      return { content: [{ type: "text", text: "ok" }] };
    },
  };

  // Register every tool from the shared catalog, which the MCP client mirrors
  // from the same source, so the two cannot drift (agora-ol3).
  for (const { name, description, schema } of matrixToolCatalog) {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`No handler registered for catalog tool '${name}'`);
    }
    server.registerTool(
      name,
      { description, inputSchema: schema },
      handler,
    );
  }

  return server;
}

app.post("/mcp", async (req, res) => {
  let accessToken: string;
  try {
    accessToken = extractAccessToken(req);
  } catch (err) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: (err as Error).message },
      id: null,
    });
    return;
  }

  const matrixUserId = extractMatrixUserId(req);
  const server = buildServer(accessToken, matrixUserId);
  try {
    // Stateless mode: a fresh server+transport per request. Matrix has no
    // persistent connection to hold, so this costs nothing per tool call.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => {
  console.log(`agora matrix-mcp listening on :${port}`);
});
