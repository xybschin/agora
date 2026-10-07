import type { AgentDefinition } from "@agora/shared";
import { appendEvent, matrixWaitForActivityTimeoutMs } from "@agora/shared";
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
  logDir: string;
  mcp: MatrixMcpClient;
  llm: LlmConfig;
  /**
   * How long each long-poll for new room activity blocks before the loop gives
   * up and re-waits. Defaults to the shared tool's max (30s) but is injected so
   * tests can drive the loop with a short wait.
   */
  waitTimeoutMs?: number;
  /**
   * Optional stop predicate, checked at the top of each loop iteration; when it
   * returns true the loop returns cleanly. In production the loop runs for the
   * life of the process (the predicate is usually absent, so the loop never
   * stops on its own); it exists as a test seam to bound an otherwise-infinite
   * loop and as the hook a graceful stop could use.
   */
  isStopped?: () => boolean;
}

export interface TurnResult {
  stance: number;
  usage: { promptTokens: number; completionTokens: number };
}

export interface TurnMessageParams {
  /** The agent's turn number, 1-based, monotonic per Run. */
  turn: number;
  /** Room messages that arrived since the agent's last turn; 0 = nothing new. */
  newMessages: number;
  /** The agent's most recent own post, if any, quoted so it is not restated. */
  ownLastMessage?: string;
}

/**
 * Builds the per-turn user message that replaces the frozen "Tick N: it is
 * your turn" (mechanism C: no news in per-tick prompts). Carries the two
 * deltas the turn should act on -- what arrived since the last turn, and what
 * the agent itself last said so it does not restate it -- instead of an
 * invitation that reads identically every turn. The per-agent turn counter
 * keeps a sense of sequence now that there is no global tick to number the run
 * by; the turn is driven by activity, not by a schedule.
 *
 * Kept short (a hard cap around 200 chars): the news is context for the turn,
 * not the conversation itself, and a long preamble would crowd the model's
 * budget for the room it reads afterwards.
 */
export function buildTurnMessage({
  turn,
  newMessages,
  ownLastMessage,
}: TurnMessageParams): string {
  const head = `Turn ${turn}.`;
  const news =
    newMessages <= 0
      ? ` Nothing new since your last turn.`
      : ` ${newMessages} new message${newMessages === 1 ? "" : "s"} since your last turn.`;
  // Quote only the first line of a multi-line own post, truncated so the whole
  // message stays short. The full text is already quoted in the system prompt
  // (buildSystemPrompt); here a compact marker is enough to say "you said this,
  // don't repeat it" without letting one long post blow past the length cap.
  const lastLine = ownLastMessage?.split("\n")[0] ?? "";
  const quote = lastLine.length > 80 ? `${lastLine.slice(0, 80)}…` : lastLine;
  const own = ownLastMessage != null ? ` You already said: "${quote}". Don't restate it.` : "";
  return `${head}${news}${own}`.trim();
}

/**
 * How many of the agent's own successfully posted messages the runtime keeps to
 * remind it not to restate them (mechanism C of the repetition investigation:
 * no self-history). A small bounded queue -- the last 2-3 posts -- is enough:
 * the agent's recent commitments are what it tends to reproduce verbatim, and
 * a longer list would crowd the prompt for little gain.
 */
const OWN_MESSAGE_HISTORY_MAX = 3;

/**
 * The limit the runtime requests when counting room messages for the per-turn
 * news (see countRoomMessages): the tool's maximum, so the count is a measure
 * of total room growth rather than a value capped at a short window. Mirrors
 * matrixReadRoomSchema's max; kept separate so the two intents can drift
 * independently.
 */
const ROOM_COUNT_LIMIT = 100;

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
 * tool-calls at a time, until it stops calling tools or hits the per-turn
 * tool-step limit (the safety cap against runaway loops, Q16 + Q21).
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

  /**
   * The room's message count as of the last turn's start, as observed by the
   * runtime's own light read (see countRoomMessages). The delta between this
   * and the count at the current turn's start is what runTurn reports as "new
   * since your last turn". Turn 1 has no prior turn, so it reports nothing new.
   */
  private lastTurnStartCount = 0;

  /**
   * Best-effort count of messages currently in the room, via one matrix_read_room
   * issued by the runtime itself (not the model) so the per-turn message can say
   * "new since your last turn" about messages the agent has not seen yet.
   *
   * Requests the tool's maximum limit (100, the schema cap) rather than the
   * model's read window so the count tracks the room's *actual* growth instead
   * of saturating at a short window: the news is "N messages arrived since your
   * last turn", independent of how much the model chooses to read.
   *
   * Deliberately never throws: the news is a nicety, not a reason to lose a
   * turn. Any failure -- homeserver hiccup, malformed response -- degrades to
   * "no new messages", keeping silent no-op turns valid.
   */
  private async countRoomMessages(): Promise<number | null> {
    try {
      const resultText = await this.config.mcp.callTool("matrix_read_room", {
        limit: ROOM_COUNT_LIMIT,
      });
      const parsed = JSON.parse(resultText) as unknown;
      return Array.isArray(parsed) ? parsed.length : null;
    } catch {
      return null;
    }
  }

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

  /** The per-turn user message most recently built. Exposed for tests. */
  private lastTurnMessage = "";
  /** Exposed for tests. */
  getLastTurnMessage(): string {
    return this.lastTurnMessage;
  }

  /**
   * Monotonic count of this agent's turns in this Run, starting at 1, used to
   * bracket a turn with `agent_turn_started`/`agent_turn_ended`. Independent
   * per agent and per Run by construction (each Run gets fresh containers and
   * a fresh runtime), and the per-agent answer to the global tick bracket it
   * replaces: with no shared tick, each agent's own turn pair is its liveness
   * evidence. In the event-driven world one turn runs per wake (see runLoop),
   * driven by room activity rather than a schedule; the counter stays a
   * per-agent count regardless of what drives the loop.
   */
  private turn = 0;

  async runTurn(): Promise<TurnResult> {
    const { runId, agentId, agentDef, topic, roomId, maxToolStepsPerTick, logDir, mcp, llm } =
      this.config;

    this.turn += 1;
    const turn = this.turn;
    await appendEvent(logDir, runId, {
      type: "agent_turn_started",
      runId,
      agentId,
      turn,
      timestamp: new Date().toISOString(),
    });

    const mcpTools = await mcp.listToolSpecs();
    const tools = [...mcpTools, STANCE_TOOL];

    // The runtime counts messages itself (rather than depending on whether the
    // model happens to read) so the per-turn news is timely, not stale. The
    // count feeds newMessages below; an unreadable room silently yields
    // "nothing new" rather than failing the turn.
    const currentCount = await this.countRoomMessages();
    const newMessages =
      turn === 1 ? 0 : Math.max(0, (currentCount ?? this.lastTurnStartCount) - this.lastTurnStartCount);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt({
          persona: agentDef.persona,
          topic,
          currentStance: this.currentStance,
          isFirstTick: turn === 1,
          ownMessageHistory: this.ownMessageHistory,
        }),
      },
      {
        role: "user",
        content: buildTurnMessage({
          turn,
          newMessages,
          ownLastMessage: this.ownMessageHistory[this.ownMessageHistory.length - 1],
        }),
      },
    ];
    this.lastTurnMessage = (messages[1] as { content: string }).content;
    // Seal the count this turn started at, so the next turn reports exactly what
    // arrived between turns. On a failed read keep the previous baseline (no
    // news rather than an invented jump).
    this.lastTurnStartCount = currentCount ?? this.lastTurnStartCount;

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
        // Malformed model arguments must not drop the turn. Degrade to the raw
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
          // Defense-in-depth: the model's args are parsed loosely (a malformed
          // call must not drop the turn), so the stance value reaching here may
          // not be a number. Guard on a finite-number check -- NOT on emptiness
          // (Number("") is 0, not NaN) -- so a bad argument can never poison the
          // agent's persistent private stance into NaN, which would otherwise
          // leak "your current private stance ... is NaN" into every later
          // system prompt. A finite numeric stance is clamped to [-1, 1] as
          // before; anything else keeps the prior stance and records that the
          // update was invalid, so a one-off bad call cannot corrupt a run.
          calledStanceTool = true;
          const rawStance = Number(args.stance);
          if (Number.isFinite(rawStance)) {
            this.currentStance = Math.max(-1, Math.min(1, rawStance));
            await appendEvent(logDir, runId, {
              type: "stance",
              runId,
              agentId,
              stance: this.currentStance,
              rationale: typeof args.rationale === "string" ? args.rationale : undefined,
              timestamp: new Date().toISOString(),
            });
            resultText = "stance recorded";
          } else {
            // Non-finite (e.g. "abc", "0.5x") or null/undefined: leave the prior
            // stance untouched and record the drop explicitly rather than
            // silently, so the transcript shows the stance was carried over.
            const prior = this.currentStance;
            await appendEvent(logDir, runId, {
              type: "stance",
              runId,
              agentId,
              stance: prior,
              rationale: "carried over -- update_stance called with an invalid (non-numeric) stance; not applied",
              timestamp: new Date().toISOString(),
            });
            resultText = `invalid stance (${String(args.stance)}) not applied; stance remains ${prior}`;
          }
        } else {
          if (call.function.name === "matrix_send_message") {
            // A model that emits the call without a body must not drop the turn
            // or reach the homeserver: `content` is required, and posting an
            // empty string would only land a meaningless event in the room. So a
            // missing or non-string body is refused here and returned as a tool
            // result the model can read and correct within the same turn (the
            // next chatCompletion sees it back in `messages`) -- the same
            // self-correction path update_stance uses for a bad value, and the
            // same principle as the malformed-JSON guard above. Throwing, as a
            // genuine homeserver rejection does, would abort the turn without
            // ever telling the model why, and a run would repeat the same bad
            // call every turn.
            const body = typeof args.content === "string" ? args.content : "";
            if (body.trim().length === 0) {
              resultText =
                "matrix_send_message rejected: 'content' must be a non-empty string. Provide the message you want to post and call the tool again, or don't post.";
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                name: call.function.name,
                content: resultText,
              });
              continue;
            }
            resultText = await mcp.callTool(call.function.name, { ...args, content: body });
            try {
              const sent = JSON.parse(resultText) as { id: string; createdAt: string };
              await appendEvent(logDir, runId, {
                type: "message",
                runId,
                agentId,
                matrixEventId: sent.id,
                roomId,
                content: body,
                replyToEventId:
                  typeof args.replyToEventId === "string" ? args.replyToEventId : undefined,
                timestamp: sent.createdAt,
              });
              // Only a fully successful post becomes a remembered commitment:
              // reaching here means the send did not throw and the transcript
              // event landed. A failed send throws above (or in callTool) and
              // never advances the queue, so a message the room never saw is
              // not offered back to the model as something to avoid restating.
              this.ownMessageHistory.push(body);
              if (this.ownMessageHistory.length > OWN_MESSAGE_HISTORY_MAX) {
                this.ownMessageHistory.shift();
              }
            } catch (parseError) {
              console.error("Failed to parse matrix_send_message response:", resultText);
              throw new Error(`Invalid response from matrix_send_message: ${resultText}`);
            }
          } else {
            resultText = await mcp.callTool(call.function.name, args);
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
        agentId,
        stance: this.currentStance,
        rationale: "carried over -- agent did not call update_stance this turn",
        timestamp: new Date().toISOString(),
      });
    }

    // Close the turn bracket. `turn_ended` is only reached when the turn runs to
    // completion — if runTurn throws part-way (a hard homeserver rejection of a
    // send, say) runLoop closes the bracket with `agent_turn_failed` instead. An
    // `agent_turn_started` left unclosed by either is the signature of a process
    // that died mid-turn, the liveness evidence this bracket exists to provide.
    await appendEvent(logDir, runId, {
      type: "agent_turn_ended",
      runId,
      agentId,
      turn,
      timestamp: new Date().toISOString(),
    });

    return {
      stance: this.currentStance,
      usage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
    };
  }

  /**
   * The agent's continuous event-driven loop, run for the life of the process.
   * Each iteration blocks on the room long-poll (`matrix_wait_for_activity`,
   * the tool the model never sees) rather than sleeping a fixed interval: it
   * wakes as soon as new activity arrives, runs a turn, then goes straight back
   * to waiting.
   *
   * While waiting, the runtime emits an `agent_heartbeat` with state
   * "waiting" — the per-agent liveness evidence that replaces the liveness the
   * old global tick bracket provided for free (no more shared tick to group
   * events by). The heartbeat is written *before* each wait, so a container
   * that has gone quiet still leaves a stream of liveness proof while it waits
   * for the room.
   *
   * The `since` resume token is threaded through the waits: each /sync returns
   * a `next_batch` that the next wait passes back, so the loop tracks the room
   * from where it left off rather than re-reading everything since the agent
   * joined. A timed-out wait with nothing new is a normal result — the loop
   * just re-waits with the fresh token.
   *
   * A transient failure *waiting* (a dropped connection, a homeserver hiccup)
   * must never crash the process or end the Run: it is caught, logged, and the
   * loop resumes waiting. The `since` token is only advanced on a successful
   * wait, so a failed wait loses nothing and retries from the same position.
   *
   * A turn that throws is caught separately: it is recorded as
   * `agent_turn_failed` (with the error) in the transcript and the loop goes
   * back to waiting. Keeping the two catches apart means a failed turn is never
   * misreported as a failed wait.
   */
  async runLoop(): Promise<void> {
    const { runId, agentId, mcp } = this.config;
    const timeoutMs = this.config.waitTimeoutMs ?? matrixWaitForActivityTimeoutMs;
    let since: string | undefined;

    for (;;) {
      if (this.config.isStopped?.()) return;

      await appendEvent(this.config.logDir, runId, {
        type: "agent_heartbeat",
        runId,
        agentId,
        state: "waiting",
        timestamp: new Date().toISOString(),
      });

      let hasActivity: boolean;
      try {
        const result = await mcp.waitForActivity({ timeoutMs, since });
        since = result.nextBatch;
        hasActivity = result.hasActivity;
      } catch (err) {
        // A dropped long-poll is transient: log and resume waiting rather than
        // letting the agent process die (which would end its half of the Run).
        console.error(`[${agentId}] waiting for room activity failed; will resume waiting:`, err);
        continue;
      }

      if (!hasActivity) continue;
      try {
        await this.runTurn();
      } catch (err) {
        // A turn that throws (an LLM call that outlasted its retries, a send the
        // homeserver rejected) closes its bracket with `agent_turn_failed` so
        // the transcript says why the agent went quiet, then the loop waits on.
        console.error(`[${agentId}] turn ${this.turn} failed; will resume waiting:`, err);
        await appendEvent(this.config.logDir, runId, {
          type: "agent_turn_failed",
          runId,
          agentId,
          turn: this.turn,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}
