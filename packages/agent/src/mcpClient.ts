import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { matrixToolCatalog, matrixWaitForActivityTool } from "@agora/shared";
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
    private readonly matrixUserId: string,
  ) {
    this.client = new Client({ name: "agora-agent", version: "0.1.0" });
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    const transport = new StreamableHTTPClientTransport(new URL(this.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "X-Matrix-User-ID": this.matrixUserId,
        }
      },
      fetch: fetch,
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async listToolSpecs(): Promise<ToolSpec[]> {
    await this.connect();
    // The server registers the very same tools from the same shared catalog, so
    // what an agent is offered here and what the server can handle cannot drift —
    // EXCEPT the runtime long-poll tool, which the loop calls through
    // `waitForActivity` and which must never be handed to the model: offered a
    // blocking wait, the model could pin a turn indefinitely. So it is filtered
    // out of the specs advertised for chat while remaining callable on the
    // server for the runtime's own use (see shared's matrixWaitForActivityTool).
    return matrixToolCatalog
      .filter(({ name }) => name !== matrixWaitForActivityTool)
      .map(({ name, description, schema }) => ({
        type: "function" as const,
        function: {
          name,
          description,
          parameters: schema.toJSONSchema(),
        },
      }));
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

  /**
   * Long-polls the run's room for new activity via the matrix_wait_for_activity
   * tool (the one tool the model never sees). Blocks up to `timeoutMs`; returns
   * whether anything new arrived and the `nextBatch` resume token to pass as
   * `since` on the next wait. A timed-out wait with nothing new is a normal,
   * non-error result (`hasActivity: false`). A client/transport failure throws
   * and is the caller's to recover from — the loop treats it as transient.
   */
  async waitForActivity(args: {
    timeoutMs: number;
    since?: string;
  }): Promise<{ hasActivity: boolean; nextBatch: string }> {
    const resultText = await this.callTool(matrixWaitForActivityTool, {
      timeoutMs: args.timeoutMs,
      since: args.since,
    });
    const parsed = JSON.parse(resultText) as { hasActivity?: boolean; nextBatch?: string };
    return {
      hasActivity: parsed.hasActivity === true,
      nextBatch: parsed.nextBatch ?? "",
    };
  }
}
