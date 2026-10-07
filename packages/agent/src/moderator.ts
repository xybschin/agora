import { appendEvent, matrixWaitForActivityTimeoutMs } from "@agora/shared";
import { chatCompletion, type ChatMessage, type ToolSpec, type LlmConfig } from "./llm.js";
import type { MatrixMcpClient } from "./mcpClient.js";
import { DEFAULT_TURN_RETRY, runTurnWithRetry, type TurnRetryOptions } from "./turnRetry.js";

export interface ModeratorRuntimeConfig {
  runId: string;
  roomId: string;
  matrixSetupUserId: string;
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
   * How long the room may stay silent before the Moderator reassesses anyway,
   * and how often it reassesses again while the silence lasts. Agents going
   * quiet produces no room activity, so without this a silent room is never
   * judged and the Run can only end on the wall-clock backstop. Measured in
   * wall-clock time rather than counted in polls, because an empty long-poll
   * can return well before its timeout. Defaults to 60s.
   */
  quietReassessAfterMs?: number;
  /** Clock, injected so tests can drive quiet-room timing without sleeping. */
  now?: () => number;
  /**
   * Optional stop predicate, checked at the top of each loop iteration; when it
   * returns true the loop returns cleanly.
   */
  isStopped?: () => boolean;
  /** How a failed Assessment is re-run; see TurnRetryOptions. Injected by tests. */
  turnRetry?: Partial<TurnRetryOptions>;
}

export interface ModeratorTurnResult {
  classification: "active" | "stale";
  shouldEnd: boolean;
}

const CLASSIFY_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "classify_discussion",
    description:
      "Classify the current state of the discussion as ACTIVE (ongoing, with new points or disagreement/engagement) or STALE (repetitive, static positions, or disengaged). Call this exactly once per assessment after reading the room.",
    parameters: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["active", "stale"],
          description: "ACTIVE if discussion is ongoing; STALE if it has gone repetitive or disengaged",
        },
        rationale: {
          type: "string",
          description:
            "One or two sentences explaining why the discussion is classified this way, referencing specific points or patterns observed",
        },
      },
      required: ["classification", "rationale"],
    },
  },
};

/**
 * The Moderator's system prompt instructs it to read the room, classify the
 * discussion, and either post nothing (ACTIVE) or compose a closing message (STALE).
 * The prompt structure ensures the classification decision comes first, and the
 * message-posting path is only reachable from STALE.
 */
function buildModeratorSystemPrompt(params: {
  topic: string;
  isFirstTurn: boolean;
}): string {
  const { topic, isFirstTurn } = params;
  return `You are a neutral Moderator observing a group discussion on the topic: "${topic}".

Your role is to:
1. Read the recent room messages (requesting as many as you need, up to the tool's limit) so you can judge how the discussion has been going
2. Classify the discussion as ACTIVE or STALE
3. Only if STALE, post a closing message

Classification rules (decide which applies):
- ACTIVE: The discussion shows new arguments, shifting positions, or open disagreement/pushback/hostility. Conflict is engagement, never reason to end.
- STALE: Arguments repeat without new additions, positions frozen across exchanges, or visible disengagement (brief replies, ignored points, trailing off).
- When unsure, prefer ACTIVE.

You are not a participant; stay neutral and never express opinions on the topic. You have no stance, persona, or private position.

IMPORTANT STRUCTURAL CONSTRAINT (enforced by construction):
- You MUST call classify_discussion exactly once per turn.
- Posting a message (matrix_send_message) is ONLY reachable after classify_discussion returns "stale".
- The two paths are mutually exclusive: if classification is "active", you CANNOT and MUST NOT call matrix_send_message.

${
  isFirstTurn
    ? ""
    : `
Your most recent assessment is above in the conversation history.

If you classified ACTIVE last turn and the discussion remains ACTIVE, do NOT post a message—just call classify_discussion again with the new evidence.
If you classified ACTIVE but now see clear staleness, re-assess and post your closing message only if the new assessment is STALE.
`
}`;
}

/**
 * Builds the per-turn user message for the Moderator. Tells it how many new
 * messages have arrived since its last assessment.
 */
function buildModeratorTurnMessage(newMessages: number, quietForMs?: number): string {
  if (quietForMs !== undefined) {
    const seconds = Math.round(quietForMs / 1000);
    return `The room has been quiet: no new messages for about ${seconds} seconds. Read the room and judge whether the discussion has trailed off (STALE) or is merely pausing (ACTIVE).`;
  }
  if (newMessages <= 0) {
    return "No new messages since your last assessment. Check if the discussion is still active or has become stale.";
  }
  return `${newMessages} new message${newMessages === 1 ? "" : "s"} since your last assessment. Read and reassess.`;
}

/**
 * Runs the Moderator's assessment loop: the model reads the room, classifies
 * the discussion, and — if STALE — posts a closing message.
 */
export class ModeratorRuntime {
  /**
   * The room's message count as of the last completed turn's start, used to
   * compute "new since last assessment" for the turn message. Sealed only when
   * an Assessment completes, so one re-run after a failure still sees the
   * activity that woke it.
   */
  private lastTurnStartCount = 0;

  /**
   * Whether the current Assessment has posted its closing message. A failed
   * Assessment that already posted is not re-run, which would post twice.
   */
  private postedThisTurn = false;

  /**
   * Monotonic count of the Moderator's Assessments in this Run, starting at 1.
   * Names the turn in `agent_turn_failed` when an Assessment throws, the same
   * way an agent's turn counter does.
   */
  private turn = 0;

  /**
   * Best-effort count of messages currently in the room.
   */
  private async countRoomMessages(): Promise<number | null> {
    try {
      const resultText = await this.config.mcp.callTool("matrix_read_room", {
        limit: 100,
      });
      const parsed = JSON.parse(resultText) as unknown;
      return Array.isArray(parsed) ? parsed.length : null;
    } catch {
      return null;
    }
  }

  constructor(private readonly config: ModeratorRuntimeConfig) {}

  /**
   * Runs the Moderator's assessment turn: reads the room, classifies the
   * discussion, and if STALE, posts a closing message and signals that the
   * Run should end. `quietForMs` is set when the turn was triggered by the room
   * staying silent rather than by new activity.
   */
  async runTurn(opts?: { quietForMs?: number }): Promise<ModeratorTurnResult> {
    const { runId, roomId, matrixSetupUserId, logDir, mcp, llm } = this.config;
    this.turn += 1;
    this.postedThisTurn = false;

    await appendEvent(logDir, runId, {
      type: "agent_heartbeat",
      runId,
      agentId: "moderator",
      state: "active",
      timestamp: new Date().toISOString(),
    });

    const mcpTools = await mcp.listToolSpecs();
    const tools = [...mcpTools, CLASSIFY_TOOL];

    const currentCount = await this.countRoomMessages();
    const newMessages = this.lastTurnStartCount === 0 ? 0 : Math.max(0, (currentCount ?? this.lastTurnStartCount) - this.lastTurnStartCount);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildModeratorSystemPrompt({
          topic: "the discussion",
          isFirstTurn: this.lastTurnStartCount === 0,
        }),
      },
      {
        role: "user",
        content: buildModeratorTurnMessage(newMessages, opts?.quietForMs),
      },
    ];

    let classification: "active" | "stale" = "active";
    let rationale = "";
    let closingMessageId: string | null = null;

    // The tool-calling loop. The model must call classify_discussion exactly once.
    // Only after a STALE classification can it call matrix_send_message.
    for (let step = 0; step < 10; step++) {
      // Safety cap on tool calls to prevent runaway loops
      const { message } = await chatCompletion(llm, messages, tools);
      messages.push(message);

      if (!message.tool_calls || message.tool_calls.length === 0) {
        break;
      }

      for (const call of message.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = { raw: call.function.arguments };
        }

        let resultText: string;

        if (call.function.name === "classify_discussion") {
          // Record the classification event.
          const rawClassification = String(args.classification).toLowerCase();
          if (rawClassification === "active" || rawClassification === "stale") {
            classification = rawClassification as "active" | "stale";
            rationale = typeof args.rationale === "string" ? args.rationale : "";
            await appendEvent(logDir, runId, {
              type: "moderator_classification",
              runId,
              classification,
              rationale,
              timestamp: new Date().toISOString(),
            });
            resultText = `classification recorded: ${classification}`;
          } else {
            resultText = `invalid classification "${String(args.classification)}"; must be "active" or "stale"`;
          }
        } else if (call.function.name === "matrix_send_message") {
          // STRUCTURAL INVARIANT: posting is only reachable from STALE path.
          // Verify at the gate: if classification is ACTIVE, reject the message.
          if (classification !== "stale") {
            resultText =
              "ERROR: You can only post a message after classifying the discussion as STALE. " +
              `Current classification is "${classification}". Do not call matrix_send_message.`;
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: resultText,
            });
            continue;
          }

          const body = typeof args.content === "string" ? args.content : "";
          if (body.trim().length === 0) {
            resultText =
              "matrix_send_message rejected: 'content' must be a non-empty string. Provide your closing message.";
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function.name,
              content: resultText,
            });
            continue;
          }

          resultText = await mcp.callTool(call.function.name, { ...args, content: body });
          this.postedThisTurn = true;
          try {
            const sent = JSON.parse(resultText) as { id: string; createdAt: string };
            closingMessageId = sent.id;
            await appendEvent(logDir, runId, {
              type: "message",
              runId,
              agentId: "moderator",
              matrixEventId: sent.id,
              roomId,
              content: body,
              timestamp: sent.createdAt,
            });
            resultText = `message posted (${sent.id})`;
          } catch (parseError) {
            console.error("Failed to parse matrix_send_message response:", resultText);
            throw new Error(`Invalid response from matrix_send_message: ${resultText}`);
          }
        } else {
          // Other MCP tools (e.g. matrix_read_room for reading the discussion).
          resultText = await mcp.callTool(call.function.name, args);
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultText,
        });
      }
    }

    this.lastTurnStartCount = currentCount ?? this.lastTurnStartCount;

    // Record the "Moderator ended Run" event only if STALE and we posted.
    if (classification === "stale" && closingMessageId) {
      await appendEvent(logDir, runId, {
        type: "moderator_ended_run",
        runId,
        rationale,
        messageId: closingMessageId,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      classification,
      shouldEnd: classification === "stale" && closingMessageId !== null,
    };
  }

  /**
   * The Moderator's continuous event-driven loop, run for the life of the process
   * (or until it ends the Run by classifying STALE).
   *
   * Each iteration blocks on the room long-poll, wakes when activity arrives,
   * runs an assessment, and either continues waiting (ACTIVE) or ends the Run
   * (STALE). Each time the room has stayed silent for `quietReassessAfterMs`
   * (since the last activity or the last quiet assessment), it assesses anyway
   * and tells the model how long the room has been silent in total: silence is
   * itself evidence the discussion may have trailed off.
   *
   * While waiting, emits an agent_heartbeat to provide liveness evidence.
   *
   * A failed wait is logged and re-waited from the same `since`; a failed
   * Assessment is caught separately and recorded as `agent_turn_failed`, so the
   * two failure modes stay distinguishable, then re-run after a backoff (with
   * the same quiet-room context) up to the retry cap before the loop waits on.
   */
  async runLoop(): Promise<void> {
    const { runId, mcp } = this.config;
    const timeoutMs = this.config.waitTimeoutMs ?? matrixWaitForActivityTimeoutMs;
    const quietReassessAfterMs = this.config.quietReassessAfterMs ?? 60_000;
    const now = this.config.now ?? Date.now;
    const turnRetry = { ...DEFAULT_TURN_RETRY, ...this.config.turnRetry };
    let since: string | undefined;
    // Silence is measured from the last room activity; reassessment during a
    // silence is paced from the last assessment, so a pause judged ACTIVE is
    // looked at again later with the full quiet time.
    let lastActivityAt = now();
    let lastAssessedAt = lastActivityAt;

    for (;;) {
      if (this.config.isStopped?.()) return;

      await appendEvent(this.config.logDir, runId, {
        type: "agent_heartbeat",
        runId,
        agentId: "moderator",
        state: "waiting",
        timestamp: new Date().toISOString(),
      });

      let hasActivity: boolean;
      try {
        const result = await mcp.waitForActivity({ timeoutMs, since });
        since = result.nextBatch;
        hasActivity = result.hasActivity;
      } catch (err) {
        console.error("[moderator] waiting for room activity failed; will resume waiting:", err);
        continue;
      }

      let opts: { quietForMs?: number } | undefined;
      const polledAt = now();
      if (hasActivity) {
        lastActivityAt = lastAssessedAt = polledAt;
      } else if (polledAt - lastAssessedAt >= quietReassessAfterMs) {
        lastAssessedAt = polledAt;
        opts = { quietForMs: polledAt - lastActivityAt };
      } else {
        continue;
      }

      const result = await runTurnWithRetry("moderator", turnRetry, () => this.runTurn(opts), async (err) => {
        // A failed Assessment is recorded so the transcript says why the
        // Moderator went quiet.
        console.error(`[moderator] turn ${this.turn} failed:`, err);
        await appendEvent(this.config.logDir, runId, {
          type: "agent_turn_failed",
          runId,
          agentId: "moderator",
          turn: this.turn,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }, () => !this.postedThisTurn);
      // Moderator classified STALE and posted; end the Run.
      if (result?.shouldEnd) return;
    }
  }
}
