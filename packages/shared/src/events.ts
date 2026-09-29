interface BaseEvent {
  runId: string;
  tick: number;
  timestamp: string;
}

export interface TickBoundaryEvent extends BaseEvent {
  type: "tick_start" | "tick_end";
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

export type AgoraEvent =
  | TickBoundaryEvent
  | MessageEvent
  | StanceEvent
  | UsageEvent
  | RunStartedEvent
  | RunCompletedEvent
  | RunAbortedEvent;
