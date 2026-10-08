/**
 * The operator's live window onto a Run, fed by `superviseRunToTerminal` on
 * every transcript poll: prints Moderator Assessments and failed turns, and
 * warns when the Moderator goes silent. Read-only; it never writes events.
 */
import { createLogger, type SequencedEvent } from "@agora/shared";

const log = createLogger("runner");

/**
 * Two missed Moderator heartbeats: the Moderator writes one before every
 * room long-poll, and each long-poll gives up after
 * `matrixWaitForActivityTimeoutMs`, so this long with nothing from it means it
 * has crashed, never started, or is stuck, rather than that the Run is merely
 * quiet.
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
 * (agora-6s2.2). Failed turns, an agent's or the Moderator's, are printed the
 * same way (agora-5su.5), so a Run stalled by e.g. a provider 429 is visible
 * without reading the transcript afterwards. The terminal is the only surface:
 * Assessments are never posted to the room, so the agents cannot react to
 * being judged (ADR-0008).
 *
 * `observe` is handed the whole transcript on every poll. What has been seen is
 * tracked by line position, not by `seq`, because `seq` is not unique per Run
 * (agora-6s2.6) and would drop a second Assessment that shares one.
 */
export function createModeratorWatch(deps: ModeratorWatchDeps = {}) {
  const print = deps.print ?? ((line) => log.info(line));
  const warn = deps.warn ?? ((line) => log.warn(line));
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
        print(formatAssessment(event.classification, event.rationale));
      }
      if (event.type === "agent_turn_failed") {
        print(`Turn failed: ${event.agentId} turn ${event.turn} — ${event.error}`);
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
        `the Moderator has written nothing (no heartbeat, no Assessment) for ` +
          `${Math.round(quietForMs / 1000)}s; it may have crashed or never started.`,
      );
    }
  }

  return { observe };
}

export type ModeratorWatch = ReturnType<typeof createModeratorWatch>;

/** Any event the Moderator's container wrote; all of them count as proof of life. */
function isFromModerator(event: SequencedEvent): boolean {
  if (event.type === "moderator_classification" || event.type === "moderator_ended_run") return true;
  return "agentId" in event && event.agentId === "moderator";
}

function formatAssessment(classification: "active" | "stale", rationale: string): string {
  return `Moderator Assessment: ${classification.toUpperCase()} — ${rationale}`;
}
