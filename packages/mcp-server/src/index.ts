import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  matrixReadRoomSchema,
  matrixSendMessageSchema,
  matrixAddReactionSchema,
} from "@agora/shared";
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

  server.registerTool(
    "matrix_read_room",
    {
      description: "Read recent messages from the scenario's Matrix room, oldest first.",
      inputSchema: matrixReadRoomSchema,
    },
    async ({ limit }) => {
      const client = getMatrixClient(accessToken);
      const messages = await readRoom(client, roomId, limit, matrixUserId);
      return { content: [{ type: "text", text: JSON.stringify(messages) }] };
    },
  );

  server.registerTool(
    "matrix_send_message",
    {
      description:
        "Post a message to the room. Set replyToEventId when directly responding to a specific earlier message.",
      inputSchema: matrixSendMessageSchema,
    },
    async ({ content, replyToEventId }) => {
      const client = getMatrixClient(accessToken);
      const sent = await sendMessage(client, roomId, content, replyToEventId);
      return { content: [{ type: "text", text: JSON.stringify(sent) }] };
    },
  );

  server.registerTool(
    "matrix_add_reaction",
    {
      description:
        "React to a message with an emoji, e.g. as a lightweight agree/disagree signal.",
      inputSchema: matrixAddReactionSchema,
    },
    async ({ eventId, reaction }) => {
      const client = getMatrixClient(accessToken);
      await addReaction(client, roomId, eventId, reaction);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

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
