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

export type AgoraEvent =
  | MessageEvent
  | StanceEvent
  | UsageEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunAbortedEvent
  | AgentTurnStartedEvent
  | AgentTurnEndedEvent
  | AgentHeartbeatEvent;

/**
 * An event as it appears on disk: every write carries a monotonic per-Run `seq`
 * assigned by the event-log writer at append time (see eventLog.ts). Writers
 * construct `AgoraEvent` (without `seq`); readers of a transcript read
 * `SequencedEvent`.
 */
export type SequencedEvent = AgoraEvent & { seq: number };
