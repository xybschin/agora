/**
 * Run identity and Run status: how a runId is formed and taken apart, and how a
 * Run's status is read back off its event log after the fact. Pure functions
 * with no I/O; callers load the events themselves.
 */
import type { AgoraEvent } from "./events.js";

/**
 * The single source of truth for a Run's id, so the writer (the runner) and the
 * reader (parseRunId) can never drift apart.
 *
 * A runId is `<sanitized-scenario-name>-<YYYYMMDD-HHMM>` in UTC, minute
 * resolution: `remote-work-policy-20251001-1420`. The timestamp is a readable,
 * lexicographically-sortable UTC stamp rather than epoch milliseconds, because
 * the runId is what a Run's Matrix room name and `logs/<runId>/` directory carry,
 * and a human must be able to tell two Runs of the same Scenario apart by eye
 * (see `roomNameForRun` in the runner and ADR-0003). Minute resolution is enough
 * for that — seconds would only add noise to a name a person reads.
 *
 * The scenario name keeps only `[a-z0-9-]` (lowercased, runs of anything else
 * collapsed to a single `-`), matching what a YAML filename sanitises to. The
 * timestamp is already `[a-z0-9-]`, so it passes through untouched, which is what
 * keeps the boundary between name and stamp unambiguous for parseRunId.
 */
export function formatRunId(scenarioName: string, date: Date): string {
  const stamp = date.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `${scenarioName.toLowerCase().replace(/[^a-z0-9-]+/g, "-")}-${stamp}`;
}

/**
 * Reverses formatRunId, recovering the Scenario a Run belongs to and the
 * readable UTC timestamp the runId carries. The stamp is returned as the string
 * that actually appears in the runId, `YYYYMMDD-HHMM` — a lexicographically
 * sortable value, so ordering by this field orders Runs chronologically even
 * though it is no longer an epoch number. Anything needing exact time beyond
 * minute resolution reads it off the Run's `run_started` event instead.
 */
export function parseRunId(runId: string): { scenarioName: string; timestamp: string } {
  const match = /^(.+)-(\d{8}-\d{4})$/.exec(runId);
  if (!match || !match[1] || !match[2]) {
    throw new Error(`runId "${runId}" doesn't match the "<scenario-name>-<YYYYMMDD-HHMM>" convention`);
  }
  return { scenarioName: match[1], timestamp: match[2] };
}

export type RunStatus = "aborted" | "completed" | "incomplete";

/**
 * Reads a Run status off its event log, from the terminal events the runner
 * records (packages/runner/src/runLifecycle.ts) rather than by inference:
 *
 * - `run_aborted` wins over everything, including a `run_completed` in the
 *   same file. Both together is malformed, and "stopped" is the reading an
 *   operator can safely act on.
 * - `run_completed` is the only positive evidence of success. It is NOT
 *   inferred from the highest tick: a Run that lands its final tick's events
 *   and then dies before recording completion is `incomplete`, because a false
 *   all-clear is worse than an honest gap.
 * - No terminal event means `incomplete` — the signature of a crashed or
 *   SIGKILLed Run. A deliberate cancel is recorded, so it reads as `aborted`
 *   instead of landing here.
 *
 * `run_started` exists to tell a real, started Run apart from an empty or
 * foreign log directory, and is also the marker for the legacy fallback below.
 *
 * Transcripts written before `run_started`/`run_completed` existed carry
 * neither, and recorded success only implicitly, so they keep the old
 * tick-count inference — otherwise every Run on disk would regress to
 * `incomplete` the day this vocabulary ships. `totalTicks` is the legacy
 * Scenario's final tick and is read only on that path.
 *
 * Known gap: `moderator_ended_run`, which is how a Moderator-ended Run now
 * records its ending, is not read here, so such a Run currently reports
 * `incomplete` even though the glossary counts it as completed.
 */
export function deriveRunStatus(
  events: AgoraEvent[],
  totalTicks: number,
): { status: RunStatus } {
  const isAborted = events.some((event) => event.type === "run_aborted");
  if (isAborted) return { status: "aborted" };

  const isCompleted = events.some((event) => event.type === "run_completed");
  if (isCompleted) return { status: "completed" };

  const hasStart = events.some((event) => event.type === "run_started");
  // Legacy fallback: transcripts written before run_started existed recorded
  // completion only implicitly, via the highest `tick` seen equal to the
  // Scenario's final tick. New transcripts never carry `tick`, so this branch
  // only ever fires for legacy on-disk Runs, keeping them from regressing to
  // `incomplete` the day the vocabulary changed.
  if (!hasStart && highestLegacyTick(events) === totalTicks) return { status: "completed" };

  return { status: "incomplete" };
}

/** Highest `tick` seen across events, for legacy transcripts that carry one. */
function highestLegacyTick(events: AgoraEvent[]): number {
  return events.reduce(
    (max, event) => Math.max(max, "tick" in event && typeof event.tick === "number" ? event.tick : 0),
    0,
  );
}
