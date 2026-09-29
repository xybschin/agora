import type { AgentDefinition } from "@agora/shared";
import { appendEvent } from "@agora/shared";
import { chatCompletion, type ChatMessage, type ToolSpec, type LlmConfig } from "./llm.js";
import type { MatrixMcpClient } from "./mcpClient.js";
import { buildSystemPrompt } from "./persona.js";

export interface AgentRuntimeConfig {
  runId: string;
  agentId: string;
  agentDef: AgentDefinition;
  topic: string;
  roomId: string;
  matrixUserId: string;
  maxToolStepsPerTick: number;
  memoryWindowSize: number;
  logDir: string;
  mcp: MatrixMcpClient;
  llm: LlmConfig;
}

export interface TickResult {
  stance: number;
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * How many of the agent's own successfully posted messages the runtime keeps to
 * remind it not to restate them (mechanism C of the repetition investigation:
 * no self-history). A small bounded queue -- the last 2-3 posts -- is enough:
 * the agent's recent commitments are what it tends to reproduce verbatim, and
 * a longer list would crowd the prompt for little gain.
 */
const OWN_MESSAGE_HISTORY_MAX = 3;

const STANCE_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "update_stance",
    description:
      "Record your current private stance on the topic and a short rationale. Call this once per turn, even if your stance has not changed.",
    parameters: {
      type: "object",
      properties: {
        stance: { type: "number", minimum: -1, maximum: 1, description: "Your private stance, -1 to 1" },
        rationale: { type: "string", description: "One sentence explaining your current stance" },
      },
      required: ["stance"],
    },
  },
};

/**
 * Runs one agent's tool-calling loop: the model itself decides when to call
 * matrix_read_room / matrix_send_message / update_stance, one round of
 * tool-calls at a time, until it stops calling tools or hits
 * maxToolStepsPerTick (the safety cap against runaway loops, Q16 + Q21).
 */
export class AgentRuntime {
  private currentStance: number;
  /**
   * The agent's own successfully posted messages (most recent last), kept so
   * it can recognize and avoid restating commitments it has already made.
   * Bounded to OWN_MESSAGE_HISTORY_MAX. Scoped to this instance, which is one
   * agent in one Run: each agent container constructs its own AgentRuntime at
   * process start, and each Run starts fresh containers, so the queue is
   * isolated per agent and per Run by construction.
   */
  private ownMessageHistory: string[] = [];

  constructor(private readonly config: AgentRuntimeConfig) {
    this.currentStance = config.agentDef.persona.initialStance;
  }

  getStance(): number {
    return this.currentStance;
  }

  /** The agent's own recent posts, oldest first. Exposed for tests. */
  getOwnMessageHistory(): readonly string[] {
    return this.ownMessageHistory;
  }

  async runTick(tick: number): Promise<TickResult> {
    const { runId, agentId, agentDef, topic, roomId, maxToolStepsPerTick, memoryWindowSize, logDir, mcp, llm } =
      this.config;

    const mcpTools = await mcp.listToolSpecs();
    const tools = [...mcpTools, STANCE_TOOL];

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          persona: agentDef.persona,
          topic,
          readWindowSize: memoryWindowSize,
          currentStance: this.currentStance,
          isFirstTick: tick === 1,
          ownMessageHistory: this.ownMessageHistory,
        }),
      },
      {
        role: "user",
        content: `Tick ${tick}: it is your turn.`,
      },
    ];

    let calledStanceTool = false;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    for (let step = 0; step < maxToolStepsPerTick; step++) {
      const { message, usage } = await chatCompletion(llm, messages, tools);
      messages.push(message);

      if (usage) {
        totalPromptTokens += usage.promptTokens;
        totalCompletionTokens += usage.completionTokens;
        await appendEvent(logDir, runId, {
          type: "usage",
          runId,
          tick,
          agentId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          timestamp: new Date().toISOString(),
        });
      }

      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }

      for (const call of message.tool_calls) {
        // Malformed model arguments must not drop the tick. Degrade to the raw
        // string so the tool still sees something and the turn continues; the
        // model can self-correct on the tool's response.
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = { raw: call.function.arguments };
        }
        let resultText: string;

        if (call.function.name === "update_stance") {
          this.currentStance = Math.max(-1, Math.min(1, Number(args.stance)));
          calledStanceTool = true;
          await appendEvent(logDir, runId, {
            type: "stance",
            runId,
            tick,
            agentId,
            stance: this.currentStance,
            rationale: typeof args.rationale === "string" ? args.rationale : undefined,
            timestamp: new Date().toISOString(),
          });
          resultText = "stance recorded";
        } else {
          resultText = await mcp.callTool(call.function.name, args);
          if (call.function.name === "matrix_send_message") {
            try {
              const sent = JSON.parse(resultText) as { id: string; createdAt: string };
              await appendEvent(logDir, runId, {
                type: "message",
                runId,
                tick,
                agentId,
                matrixEventId: sent.id,
                roomId,
                content: String(args.content ?? ""),
                replyToEventId:
                  typeof args.replyToEventId === "string" ? args.replyToEventId : undefined,
                timestamp: sent.createdAt,
              });
              // Only a fully successful post becomes a remembered commitment:
              // reaching here means the send did not throw and the transcript
              // event landed. A failed send throws above (or in callTool) and
              // never advances the queue, so a message the room never saw is
              // not offered back to the model as something to avoid restating.
              this.ownMessageHistory.push(String(args.content ?? ""));
              if (this.ownMessageHistory.length > OWN_MESSAGE_HISTORY_MAX) {
                this.ownMessageHistory.shift();
              }
            } catch (parseError) {
              console.error("Failed to parse matrix_send_message response:", resultText);
              throw new Error(`Invalid response from matrix_send_message: ${resultText}`);
            }
          }
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultText,
        });
      }
    }

    if (!calledStanceTool) {
      await appendEvent(logDir, runId, {
        type: "stance",
        runId,
        tick,
        agentId,
        stance: this.currentStance,
        rationale: "carried over -- agent did not call update_stance this tick",
        timestamp: new Date().toISOString(),
      });
    }

    return {
      stance: this.currentStance,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }
}
