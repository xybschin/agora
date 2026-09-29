import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  matrixReadRoomSchema,
  matrixSendMessageSchema,
  matrixAddReactionSchema,
} from "@agora/shared";
import type { ToolSpec } from "./llm.js";

/**
 * Thin wrapper around the MCP client that authenticates every connection
 * with this agent's own Matrix access token (Q7: identity bound to the
 * session, never passed as a tool argument).
 */
export class MatrixMcpClient {
  private readonly client: Client;
  private connected = false;

  constructor(
    private readonly mcpUrl: string,
    private readonly accessToken: string,
  ) {
    this.client = new Client({ name: "agora-agent", version: "0.1.0" });
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${this.accessToken}` } },
      fetch: fetch,
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async listToolSpecs(): Promise<ToolSpec[]> {
    await this.connect();
    return [
      {
        type: "function" as const,
        function: {
          name: "matrix_read_room",
          description: "Read recent messages from the scenario's Matrix room, oldest first.",
          parameters: matrixReadRoomSchema.toJSONSchema(),
        },
      },
      {
        type: "function" as const,
        function: {
          name: "matrix_send_message",
          description:
            "Post a message to the room. Set replyToEventId when directly responding to a specific earlier message.",
          parameters: matrixSendMessageSchema.toJSONSchema(),
        },
      },
      {
        type: "function" as const,
        function: {
          name: "matrix_add_reaction",
          description: "React to a message with an emoji, e.g. as a lightweight agree/disagree signal.",
          parameters: matrixAddReactionSchema.toJSONSchema(),
        },
      },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.connect();
    try {
      const result = await this.client.callTool({ name, arguments: args });

      if (!Array.isArray(result.content)) {
        return JSON.stringify(result);
      }

      const text = (result.content as Array<{ type: string; text?: string }>)
        .find((c) => c.type === "text")?.text;
      return text ?? JSON.stringify(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP tool call failed for ${name}: ${errorMessage}`);
    }
  }
}
