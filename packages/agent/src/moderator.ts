import { appendEvent, matrixWaitForActivityTimeoutMs, type RosterAgent } from "@agora/shared";
import { chatCompletion, type ChatMessage, type ToolSpec, type LlmConfig } from "./llm.js";
import type { MatrixMcpClient } from "./mcpClient.js";
import { DEFAULT_TURN_RETRY, runTurnWithRetry, type TurnRetryOptions } from "./turnRetry.js";
import { DEFAULT_WAIT_BACKOFF, waitBackoffDelay, type WaitBackoffOptions } from "./waitBackoff.js";

export interface ModeratorRuntimeConfig {
  runId: string;
  /** The Scenario's topic, so the Moderator can judge whether arguments are on-topic. */
  topic: string;
  roomId: string;
  matrixSetupUserId: string;
  logDir: string;
  /**
   * The Scenario's agents with their Matrix users. A STALE Assessment is
   * refused while any of them has not yet posted in the room. Omitted means no
   * roster, so nothing is waited for.
   */
  roster?: readonly RosterAgent[];
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
  /** How long to back off after a failed wait; see WaitBackoffOptions. Injected by tests. */
  waitBackoff?: Partial<WaitBackoffOptions>;
}

export interface ModeratorTurnResult {
  classification: "active" | "stale";
  shouldEnd: boolean;
}

/** One earlier Assessment, as carried into the Moderator's next Assessment. */
interface PriorAssessment {
  classification: "active" | "stale";
  rationale: string;
  /** When it was made, on the runtime's (injectable) clock. */
  at: number;
}

/**
 * How many of its most recent Assessments the Moderator is shown. Enough to see
 * whether positions have frozen since it last looked, without the prompt
 * growing for the whole Run.
 */
const PRIOR_ASSESSMENTS_SHOWN = 5;

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
  priorAssessments: PriorAssessment[];
  now: number;
}): string {
  const { topic, priorAssessments, now } = params;
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

${buildPriorAssessmentsSection(priorAssessments, now)}`;
}

/**
 * Describes the Moderator's earlier Assessments (oldest first) so it can judge
 * change over time, e.g. whether positions have frozen since it last looked.
 */
function buildPriorAssessmentsSection(priorAssessments: PriorAssessment[], now: number): string {
  if (priorAssessments.length === 0) {
    return "This is your first assessment of this discussion.\n";
  }
  const lines = priorAssessments.map(({ classification, rationale, at }) => {
    const secondsAgo = Math.max(0, Math.round((now - at) / 1000));
    return `- ${secondsAgo} seconds ago: ${classification.toUpperCase()}: ${rationale || "(no rationale given)"}`;
  });
  return `Your earlier assessments of this discussion (oldest first, at most the last ${PRIOR_ASSESSMENTS_SHOWN}):
${lines.join("\n")}

Compare the room now with what you saw then. If you classified ACTIVE last time and the discussion remains ACTIVE, do NOT post a message—just call classify_discussion again with the new evidence.
If you classified ACTIVE but now see clear staleness, re-assess and post your closing message only if the new assessment is STALE.
`;
}

/**
 * Builds the per-turn user message for the Moderator. The first Assessment is
 * told the discussion has just begun and how many messages the room holds;
 * later Assessments woken by room activity are told how many messages arrived
 * since the previous one; quiet-room reassessments are told how long the room
 * has been silent. `messageCount` is null when the room could not be counted.
 */
export function buildModeratorTurnMessage(params: {
  isFirstAssessment: boolean;
  messageCount: number | null;
  newMessages: number;
  quietForMs?: number;
}): string {
  const { isFirstAssessment, messageCount, newMessages, quietForMs } = params;
  if (quietForMs !== undefined) {
    const seconds = Math.round(quietForMs / 1000);
    return `The room has been quiet: no new messages for about ${seconds} seconds. Read the room and judge whether the discussion has trailed off (STALE) or is merely pausing (ACTIVE).`;
  }
  if (isFirstAssessment) {
    const holds =
      messageCount === null
        ? "Read the room to see what has been said so far."
        : `The room holds ${messageCount} message${messageCount === 1 ? "" : "s"} so far.`;
    return `This is your first assessment: the discussion has just started. ${holds} Read the room and assess.`;
  }
  if (newMessages <= 0) {
    // Woken by room activity, but the count did not move (it could not be
    // read, or the room holds more than one read returns): never claim silence.
    return "There has been new activity in the room since your last assessment. Read and reassess.";
  }
  return `${newMessages} new message${newMessages === 1 ? "" : "s"} since your last assessment. Read and reassess.`;
}

/** Upper bound on a logged tool result summary, so the event log never carries a room dump. */
const TOOL_RESULT_SUMMARY_MAX_CHARS = 200;

/**
 * Summarises a tool result for the event log: a room read becomes its message
 * count, anything else is truncated to a bounded length.
 */
function summarizeToolResult(tool: string, resultText: string): string {
  if (tool === "matrix_read_room") {
    try {
      const parsed = JSON.parse(resultText) as unknown;
      if (Array.isArray(parsed)) return `${parsed.length} message${parsed.length === 1 ? "" : "s"}`;
    } catch {
      // Not a message list (e.g. an error string); fall through to truncation.
    }
  }
  return resultText.length > TOOL_RESULT_SUMMARY_MAX_CHARS
    ? `${resultText.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS - 1)}…`
    : resultText;
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

  /** Whether an Assessment has run yet, so the first one can say so. */
  private hasAssessed = false;

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

  /** The most recent Assessments, oldest first, bounded to PRIOR_ASSESSMENTS_SHOWN. */
  private priorAssessments: PriorAssessment[] = [];

  /**
   * Matrix users seen posting a message in the room. Accumulated across every
   * read, so an agent that spoke once stays counted after its message scrolls
   * out of the read window.
   */
  private readonly speakers = new Set<string>();

  /**
   * Best-effort count of messages currently in the room.
   */
  private async countRoomMessages(): Promise<number | null> {
    try {
      const resultText = await this.config.mcp.callTool("matrix_read_room", {
        limit: 100,
      });
      const parsed = JSON.parse(resultText) as unknown;
      if (!Array.isArray(parsed)) return null;
      this.noteSpeakers(parsed);
      return parsed.length;
    } catch {
      return null;
    }
  }

  /** Records the senders of the messages (not reactions) in a room read. */
  private noteSpeakers(roomMessages: unknown[]): void {
    for (const entry of roomMessages) {
      const { sender, content } = (entry ?? {}) as { sender?: unknown; content?: unknown };
      if (typeof sender !== "string") continue;
      if (typeof content === "string" && content.startsWith("[reaction] ")) continue;
      this.speakers.add(sender);
    }
  }

  /**
   * The roster agents that have not yet posted in the room, re-reading the room
   * first so a message that arrived during the turn counts. If the read fails,
   * only what earlier reads saw is known, which errs on the side of waiting.
   */
  private async silentRosterAgents(): Promise<RosterAgent[]> {
    const roster = this.config.roster ?? [];
    if (roster.every((agent) => this.speakers.has(agent.matrixUserId))) return [];
    await this.countRoomMessages();
    return roster.filter((agent) => !this.speakers.has(agent.matrixUserId));
  }

  constructor(private readonly config: ModeratorRuntimeConfig) {}

  /** Records one of the model's tool calls in the event log. */
  private async recordToolCall(tool: string, args: Record<string, unknown>, resultText: string): Promise<void> {
    const { logDir, runId } = this.config;
    await appendEvent(logDir, runId, {
      type: "moderator_tool_call",
      runId,
      tool,
      args,
      resultSummary: summarizeToolResult(tool, resultText),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Runs the Moderator's assessment turn: reads the room, classifies the
   * discussion, and if STALE, posts a closing message and signals that the
   * Run should end. `quietForMs` is set when the turn was triggered by the room
   * staying silent rather than by new activity.
   */
  async runTurn(opts?: { quietForMs?: number }): Promise<ModeratorTurnResult> {
    const { runId, topic, roomId, matrixSetupUserId, logDir, mcp, llm } = this.config;
    const now = this.config.now ?? Date.now;
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
          topic,
          priorAssessments: this.priorAssessments,
          now: now(),
        }),
      },
      {
        role: "user",
        content: buildModeratorTurnMessage({
          isFirstAssessment: !this.hasAssessed,
          messageCount: currentCount,
          newMessages,
          quietForMs: opts?.quietForMs,
        }),
      },
    ];

    let classification: "active" | "stale" = "active";
    let rationale = "";
    let classified = false;
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
          if (typeof args.rationale !== "string" || args.rationale.trim().length === 0) {
            // Not recorded, so a STALE call without a reason cannot open the
            // posting gate; the model retries with a rationale.
            resultText =
              "classify_discussion rejected: 'rationale' must be a non-empty string. " +
              "Call classify_discussion again and say why the discussion is active or stale.";
          } else if (rawClassification === "active" || rawClassification === "stale") {
            classification = rawClassification as "active" | "stale";
            rationale = args.rationale;
            classified = true;
            // STRUCTURAL INVARIANT: the discussion cannot be STALE before every
            // roster agent has spoken; such an Assessment stands as ACTIVE.
            const silent = classification === "stale" ? await this.silentRosterAgents() : [];
            if (silent.length > 0) {
              const names = silent.map((agent) => `${agent.agentId} (${agent.matrixUserId})`).join(", ");
              classification = "active";
              rationale = `STALE refused: not every agent has posted yet (${names}). Model's rationale: ${rationale}`;
              resultText =
                "ERROR: The discussion cannot be STALE before every agent has spoken. " +
                `These agents have not posted in the room yet: ${names}. ` +
                "Your Assessment has been recorded as ACTIVE. Do not call matrix_send_message.";
            } else {
              resultText = `classification recorded: ${classification}`;
            }
            await appendEvent(logDir, runId, {
              type: "moderator_classification",
              runId,
              classification,
              rationale,
              timestamp: new Date().toISOString(),
            });
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
            await this.recordToolCall(call.function.name, args, resultText);
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
            await this.recordToolCall(call.function.name, args, resultText);
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
          try {
            resultText = await mcp.callTool(call.function.name, args);
          } catch (err) {
            // A failed read ends the Assessment; log it so the gap is visible.
            await this.recordToolCall(call.function.name, args, `failed: ${String(err)}`);
            throw err;
          }
        }

        await this.recordToolCall(call.function.name, args, resultText);
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: resultText,
        });
      }
    }

    this.lastTurnStartCount = currentCount ?? this.lastTurnStartCount;
    this.hasAssessed = true;

    if (classified) {
      this.priorAssessments = [...this.priorAssessments, { classification, rationale, at: now() }].slice(
        -PRIOR_ASSESSMENTS_SHOWN,
      );
    }

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
   * A failed wait is logged and re-waited from the same `since` after a
   * growing backoff (reset by the next successful wait); a failed
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
    const waitBackoff = { ...DEFAULT_WAIT_BACKOFF, ...this.config.waitBackoff };
    let since: string | undefined;
    let waitFailures = 0;
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
        waitFailures = 0;
      } catch (err) {
        const delay = waitBackoffDelay(waitBackoff, ++waitFailures);
        console.error(`[moderator] waiting for room activity failed; will resume waiting in ${delay}ms:`, err);
        await waitBackoff.sleep(delay);
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
