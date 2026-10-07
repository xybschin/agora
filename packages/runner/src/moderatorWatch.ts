import type { SequencedEvent } from "@agora/shared";

/**
 * Two missed Moderator heartbeats: the Moderator writes one per long-poll, so a
 * minute with nothing from it means it has crashed or never started, rather
 * than that the Run is merely quiet.
 */
export const moderatorQuietWarnAfterMs = 60_000;

export interface ModeratorWatchDeps {
  print?: (line: string) => void;
  warn?: (line: string) => void;
  now?: () => number;
  quietWarnAfterMs?: number;
}

/**
 * Shows the operator the Moderator's Assessments live, as they land in the
 * transcript, and warns once per silence when the Moderator itself goes quiet
 * (agora-6s2.2). The terminal is the only surface: Assessments are never posted
 * to the room, so the agents cannot react to being judged (ADR-0008).
 *
 * `observe` is handed the whole transcript on every poll. What has been seen is
 * tracked by line position, not by `seq`, because `seq` is not unique per Run
 * (agora-6s2.6) and would drop a second Assessment that shares one.
 */
export function createModeratorWatch(deps: ModeratorWatchDeps = {}) {
  const print = deps.print ?? console.log;
  const warn = deps.warn ?? console.warn;
  const now = deps.now ?? Date.now;
  const quietWarnAfterMs = deps.quietWarnAfterMs ?? moderatorQuietWarnAfterMs;

  let seen = 0;
  // Measured on the runner's own clock from when it observed the Moderator's
  // last event, so clock skew between containers cannot fake or hide a gap.
  let lastHeardAt = now();
  let warned = false;

  function observe(events: SequencedEvent[]): void {
    for (const event of events.slice(seen)) {
      if (event.type === "moderator_classification") {
        print(formatAssessment(event.timestamp, event.classification, event.rationale));
      }
      if (isFromModerator(event)) {
        lastHeardAt = now();
        warned = false;
      }
    }
    seen = Math.max(seen, events.length);

    const quietForMs = now() - lastHeardAt;
    if (!warned && quietForMs >= quietWarnAfterMs) {
      warned = true;
      warn(
        `Warning: the Moderator has written nothing (no heartbeat, no Assessment) for ` +
          `${Math.round(quietForMs / 1000)}s; it may have crashed or never started.`,
      );
    }
  }

  return { observe };
}

export type ModeratorWatch = ReturnType<typeof createModeratorWatch>;

function isFromModerator(event: SequencedEvent): boolean {
  if (event.type === "moderator_classification" || event.type === "moderator_ended_run") return true;
  return "agentId" in event && event.agentId === "moderator";
}

function formatAssessment(timestamp: string, classification: "active" | "stale", rationale: string): string {
  const at = new Date(timestamp);
  // An unparseable timestamp is shown as written rather than crashing supervision.
  const time = Number.isNaN(at.getTime()) ? timestamp : `${at.toISOString().slice(11, 19)} UTC`;
  return `[${time}] Moderator Assessment: ${classification.toUpperCase()} — ${rationale}`;
}
