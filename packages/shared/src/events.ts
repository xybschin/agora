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
 * activity is delimited by its own turn pair (see the always-active ADR). A
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
 * The Moderator's classification of the discussion as ACTIVE or STALE, recorded
 * after reading the room's recent activity. Exactly one per assessment cycle.
 */
export interface ModeratorClassificationEvent extends BaseEvent {
  type: "moderator_classification";
  classification: "active" | "stale";
  rationale: string;
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
  | AgentTurnFailedEvent
  | AgentHeartbeatEvent
  | ModeratorClassificationEvent
  | RunCompletedByModeratorEvent;

/**
 * An event as it appears on disk: every write carries a monotonic per-Run `seq`
 * assigned by the event-log writer at append time (see eventLog.ts). Writers
 * construct `AgoraEvent` (without `seq`); readers of a transcript read
 * `SequencedEvent`.
 */
export type SequencedEvent = AgoraEvent & { seq: number };
