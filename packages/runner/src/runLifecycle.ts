import { appendEvent, type RunAbortedEvent, type RunCompletedEvent, type RunCompletedByModeratorEvent } from "@agora/shared";

export type RunOutcome =
  | { type: "permissionsRefused"; reason: string }
  | { type: "moderatorEnded"; rationale: string; messageId: string }
  | { type: "wallClockExceeded" }
  | { type: "budgetExceeded" };

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
 * proves the Run began. (Per-tick bracketing moved off this module: with the
 * global tick bracket removed, per-agent `agent_turn_started`/`agent_turn_ended`
 * pairs now delimit activity, and `deriveRunStatus` reads the resulting shape
 * as `incomplete` when no terminal event ever lands.)
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
      timestamp: new Date().toISOString(),
    });
  }

  /** Lets a later cancellation also tear down, not just record. */
  function attachComposeFile(composeFile: string): void {
    if (active) active.composeFile = composeFile;
  }

  /**
   * Whether a Run is still in flight. The tick loop consults this so a cancel
   * stops it at the next tick boundary: without it the loop keeps firing fresh
   * rounds while the signal handler tears down, and posts events *after* the
   * terminal event. The verdict survives that, but a transcript whose last
   * event is a terminal one is the whole point, and false activity trailing an
   * abort is precisely what teaches a reader not to trust one.
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
    event: RunAbortedEvent | RunCompletedEvent | RunCompletedByModeratorEvent,
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
    // The terminal event no longer needs a tick-based sentinel: with per-event
    // `seq` stamped by the writer, exactly where a cancel landed in the event
    // stream is knowable from this event's own `seq`, and `deriveRunStatus`
    // no longer reads a tick off it.
    await recordTerminal(run.runId, {
      type: "run_aborted",
      runId: run.runId,
      reason: `cancelled by ${signal}`,
      timestamp: new Date().toISOString(),
    });
    if (run.composeFile) {
      await teardownContainers(run.composeFile);
    }
  }

  /**
   * Records a Run's terminal outcome. The sole place constructing run_aborted,
   * run_completed, and moderator_ended_run event literals, so event construction
   * has one place that controls it. Returns false when the run is no longer
   * active (already closed out by a concurrent signal or a previous call).
   */
  async function recordOutcome(runId: string, outcome: RunOutcome): Promise<boolean> {
    switch (outcome.type) {
      case "permissionsRefused":
        return recordTerminal(runId, {
          type: "run_aborted",
          runId,
          reason: outcome.reason,
          timestamp: new Date().toISOString(),
        });
      case "moderatorEnded":
        return recordTerminal(runId, {
          type: "moderator_ended_run",
          runId,
          rationale: outcome.rationale,
          messageId: outcome.messageId,
          timestamp: new Date().toISOString(),
        });
      case "wallClockExceeded":
        return recordTerminal(runId, {
          type: "run_aborted",
          runId,
          reason: "wall-clock runtime limit exceeded",
          timestamp: new Date().toISOString(),
        });
      case "budgetExceeded":
        return recordTerminal(runId, {
          type: "run_aborted",
          runId,
          reason: "token budget exceeded",
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
