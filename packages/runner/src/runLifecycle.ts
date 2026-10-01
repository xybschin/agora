import { appendEvent, type RunAbortedEvent, type RunCompletedEvent } from "@agora/shared";

export type RunOutcome =
  | { type: "permissionsRefused"; reason: string }
  | { type: "ticksAborted"; ticksRun: number; reason: string }
  | { type: "completed"; ticksRun: number };

export interface RunLifecycleDeps {
  logDir: string;
  composeDown: (composeFile: string) => Promise<void>;
}

/**
 * Owns the bookkeeping that decides how a Run's transcript ends.
 *
 * A Run is ended by exactly one terminal event, and two paths can reach for it:
 * the normal flow and the SIGINT/SIGTERM handler. Ownership is the mutual
 * exclusion — whoever writes the terminal event claims the run, and every other
 * path is a no-op from then on. Without it, a Ctrl-C during the last tick leaves
 * the transcript carrying both `run_aborted` and `run_completed`, which is worse
 * than either verdict alone.
 *
 * A crash is the case this cannot cover, and deliberately so: nothing can
 * record its own death. What it gets instead is bracketing — `run_started`
 * proves the Run began, and an unclosed `tick_start`/`tick_end` pair says which
 * tick it died in. `deriveRunStatus` reads the resulting shape as `incomplete`.
 */
export function createRunLifecycle(deps: RunLifecycleDeps) {
  const { logDir, composeDown } = deps;

  let active: { runId: string; composeFile?: string } | null = null;
  let teardown: Promise<void> | null = null;

  /**
   * Teardown is memoised because a cancel races the normal path: the signal
   * handler and the caller's `finally` can both reach for it, and `docker
   * compose down` run twice concurrently against one project fails noisily.
   */
  function teardownContainers(composeFile: string): Promise<void> {
    teardown ??= composeDown(composeFile);
    return teardown;
  }

  /** Marks a Run in flight and records its start, before anything that can fail. */
  async function begin(runId: string): Promise<void> {
    active = { runId };
    await appendEvent(logDir, runId, {
      type: "run_started",
      runId,
      tick: 0,
      timestamp: new Date().toISOString(),
    });
  }

  /** Lets a later cancellation also tear down, not just record. */
  function attachComposeFile(composeFile: string): void {
    if (active) active.composeFile = composeFile;
  }

  /**
   * Whether a Run is still in flight. The tick loop consults this so a cancel
   * stops it at the next boundary: without it the loop keeps going while the
   * signal handler tears down, and lands a partial `tick_start`/`tick_end` pair
   * *after* the terminal event. The verdict survives that, but a transcript
   * whose last event is a terminal one is the whole point, and a bracket
   * trailing an abort is precisely what teaches a reader not to trust one.
   */
  function isActive(): boolean {
    return active !== null;
  }

  /**
   * Writes a Run's one terminal event, if this path still owns the run.
   * Returns false when someone else already closed it out.
   */
  async function recordTerminal(
    runId: string,
    event: RunAbortedEvent | RunCompletedEvent,
  ): Promise<boolean> {
    if (active?.runId !== runId) return false;
    active = null;
    await appendEvent(logDir, runId, event);
    return true;
  }

  /** Records a signal-driven cancellation and tears down. */
  async function closeOutRun(signal: string): Promise<void> {
    const run = active;
    if (!run) return;
    // tick -1 means "which tick was in flight is not knowable from here" — the
    // runner does not track the current tick, and inventing one would falsify
    // the record. It is safe because deriveRunStatus takes the *maximum* tick
    // across events, so this sentinel never lowers what the transcript already
    // established. The tick_start/tick_end pair is what says whether the cancel
    // landed mid-tick or between ticks.
    await recordTerminal(run.runId, {
      type: "run_aborted",
      runId: run.runId,
      tick: -1,
      reason: `cancelled by ${signal}`,
      timestamp: new Date().toISOString(),
    });
    if (run.composeFile) {
      await teardownContainers(run.composeFile);
    }
  }

  /**
   * Records a Run's terminal outcome. The sole place constructing run_aborted
   * and run_completed event literals, so the runId format and event construction
   * have one place that controls them. Returns false when the run is no longer
   * active (already closed out by a concurrent signal or a previous call).
   */
  async function recordOutcome(runId: string, outcome: RunOutcome): Promise<boolean> {
    switch (outcome.type) {
      case "permissionsRefused":
        return recordTerminal(runId, {
          type: "run_aborted",
          runId,
          tick: 0,
          reason: outcome.reason,
          timestamp: new Date().toISOString(),
        });
      case "ticksAborted":
        return recordTerminal(runId, {
          type: "run_aborted",
          runId,
          tick: outcome.ticksRun,
          reason: outcome.reason,
          timestamp: new Date().toISOString(),
        });
      case "completed":
        return recordTerminal(runId, {
          type: "run_completed",
          runId,
          tick: outcome.ticksRun,
          timestamp: new Date().toISOString(),
        });
    }
  }

  return {
    begin,
    attachComposeFile,
    isActive,
    recordTerminal,
    recordOutcome,
    teardownContainers,
    closeOutRun,
  };
}

export type RunLifecycle = ReturnType<typeof createRunLifecycle>;
