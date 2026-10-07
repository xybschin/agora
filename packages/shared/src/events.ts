interface BaseEvent {
  runId: string;
  timestamp: string;
}

export interface MessageEvent extends BaseEvent {
  type: "message";
  agentId: string;
  matrixEventId: string;
  roomId: string;
  content: string;
  replyToEventId?: string;
}

export interface StanceEvent extends BaseEvent {
  type: "stance";
  agentId: string;
  stance: number;
  rationale?: string;
}

export interface UsageEvent extends BaseEvent {
  type: "usage";
  agentId: string;
  promptTokens: number;
  completionTokens: number;
}

export interface RunStartedEvent extends BaseEvent {
  type: "run_started";
}

export interface RunCompletedEvent extends BaseEvent {
  type: "run_completed";
}

export interface RunAbortedEvent extends BaseEvent {
  type: "run_aborted";
  reason: string;
}

/**
 * Brackets one agent's turn. `turn` is a monotonic, per-agent counter starting
 * at 1, independent per agent and per Run. Together with `agent_heartbeat`
 * these replace the old global `tick_start`/`tick_end` bracket as the per-agent
 * liveness evidence: with no shared tick to group events by, each agent's
 * activity is delimited by its own turn pair (see the always-active ADR).
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
 * The Moderator's classification of the discussion as ACTIVE or STALE, recorded
 * after reading the room's recent activity. Exactly one per assessment cycle.
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
 * Recorded when the Moderator ends the Run after classifying the discussion STALE.
 * This is a terminal outcome distinct from wall-clock or budget backstops firing.
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
  | AgentHeartbeatEvent
  | ModeratorClassificationEvent
  | ModeratorToolCallEvent
  | RunCompletedByModeratorEvent;

/**
 * An event as it appears on disk: every write carries a monotonic per-Run `seq`
 * assigned by the event-log writer at append time (see eventLog.ts). Writers
 * construct `AgoraEvent` (without `seq`); readers of a transcript read
 * `SequencedEvent`.
 */
export type SequencedEvent = AgoraEvent & { seq: number };
