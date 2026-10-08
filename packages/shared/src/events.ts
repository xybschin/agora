/**
 * The event vocabulary of a Run's event log (`logs/<runId>/events.jsonl`).
 * `AgoraEvent` is the closed union every writer constructs and every reader
 * switches on; eventLog.ts appends them, and runAnalysis.ts reads a Run status
 * back off them. Only `message` events make up the Transcript; the rest are
 * stances, usage, lifecycle markers, turn brackets and Moderator bookkeeping
 * recorded alongside it.
 */
/** Fields every event carries. `timestamp` is an ISO-8601 string set by the writer. */
interface BaseEvent {
  runId: string;
  timestamp: string;
}

/** One message posted to the Run's room; the unit of the Transcript. */
export interface MessageEvent extends BaseEvent {
  type: "message";
  agentId: string;
  matrixEventId: string;
  roomId: string;
  content: string;
  replyToEventId?: string;
}

/** An agent's recorded private stance on the topic, -1 (against) to +1 (in favor). */
export interface StanceEvent extends BaseEvent {
  type: "stance";
  agentId: string;
  stance: number;
  rationale?: string;
}

/** Token usage of one LLM call, which the runner sums to enforce the Scenario's budget. */
export interface UsageEvent extends BaseEvent {
  type: "usage";
  agentId: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Written by the runner before anything that can fail, so a Run with no
 * terminal event after it reads as incomplete rather than as nothing (see
 * ADR-0005).
 */
export interface RunStartedEvent extends BaseEvent {
  type: "run_started";
}

/**
 * Terminal: the Run completed. Still read by deriveRunStatus and by the
 * runner's reclaim command, but no current code path writes it: a Run the
 * Moderator ends records `moderator_ended_run` instead.
 */
export interface RunCompletedEvent extends BaseEvent {
  type: "run_completed";
}

/**
 * Terminal: the Run was stopped. `reason` names the cause (room permissions
 * refused, token budget exceeded, wall-clock runtime limit exceeded, or a
 * SIGINT/SIGTERM cancel).
 */
export interface RunAbortedEvent extends BaseEvent {
  type: "run_aborted";
  reason: string;
}

/**
 * Brackets one agent's turn. `turn` is a monotonic, per-agent counter starting
 * at 1, independent per agent and per Run. Together with `agent_heartbeat`
 * these replace the old global `tick_start`/`tick_end` bracket as the per-agent
 * liveness evidence: with no shared tick to group events by, each agent's
 * activity is delimited by its own turn pair (see ADR-0008). A
 * turn that throws closes with `agent_turn_failed` instead of `agent_turn_ended`.
 */
export interface AgentTurnStartedEvent extends BaseEvent {
  type: "agent_turn_started";
  agentId: string;
  turn: number;
}

export interface AgentTurnEndedEvent extends BaseEvent {
  type: "agent_turn_ended";
  agentId: string;
  turn: number;
}

/**
 * Closes a turn that threw instead of completing (an LLM call that outlasted
 * its retries, a homeserver rejection of a send). Written by the loop that ran
 * the turn, so an `agent_turn_started` is normally closed by exactly one of
 * `agent_turn_ended` or `agent_turn_failed`; one left unclosed now means the
 * process itself died mid-turn. `error` is the thrown error's message, so the
 * transcript alone says why an agent went quiet. `agentId` admits the
 * Moderator ("moderator"), whose `turn` counts its Assessments.
 */
export interface AgentTurnFailedEvent extends BaseEvent {
  type: "agent_turn_failed";
  agentId: string;
  turn: number;
  error: string;
}

/**
 * An agent (or the Moderator) reports it is alive while waiting for activity,
 * carrying whether it is currently waiting or actively working. `agentId`
 * admits the Moderator ("moderator") under the same shape as any agent, since
 * the Moderator is one more participant in the room emitting liveness evidence.
 */
export interface AgentHeartbeatEvent extends BaseEvent {
  type: "agent_heartbeat";
  agentId: string;
  state: "waiting" | "active";
}

/**
 * The verdict and rationale of one Moderator Assessment: ACTIVE or STALE.
 * Written each time the Moderator's model makes a valid classify_discussion
 * call, which is normally once per Assessment. A STALE verdict the Moderator
 * refuses (because some roster agent has not posted yet) is recorded as ACTIVE.
 */
export interface ModeratorClassificationEvent extends BaseEvent {
  type: "moderator_classification";
  classification: "active" | "stale";
  rationale: string;
}

/**
 * One tool call the Moderator made during an Assessment (reading the room,
 * classifying, posting), so an Observer can reconstruct what it looked at
 * before each verdict. `resultSummary` is a short, bounded description of the
 * result (e.g. "3 messages" for a room read), never the full room contents.
 * Run status and Transcript readers ignore it.
 */
export interface ModeratorToolCallEvent extends BaseEvent {
  type: "moderator_tool_call";
  tool: string;
  args: Record<string, unknown>;
  resultSummary: string;
}

/**
 * Terminal: the Moderator ended the Run after a STALE Assessment and posted its
 * closing message. This is the normal way a Run completes, distinct from the
 * wall-clock and budget backstops, which record `run_aborted`.
 */
export interface RunCompletedByModeratorEvent extends BaseEvent {
  type: "moderator_ended_run";
  rationale: string;
  messageId: string; // The Matrix event id of the Moderator's closing message
}

export type AgoraEvent =
  | MessageEvent
  | StanceEvent
  | UsageEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunAbortedEvent
  | AgentTurnStartedEvent
  | AgentTurnEndedEvent
  | AgentTurnFailedEvent
  | AgentHeartbeatEvent
  | ModeratorClassificationEvent
  | ModeratorToolCallEvent
  | RunCompletedByModeratorEvent;

/**
 * An event as it appears on disk: every write carries a `seq` assigned by the
 * event-log writer at append time. `seq` is monotonic per writing process, not
 * across the whole Run (see eventLog.ts). Writers
 * construct `AgoraEvent` (without `seq`); readers of a transcript read
 * `SequencedEvent`.
 */
export type SequencedEvent = AgoraEvent & { seq: number };
