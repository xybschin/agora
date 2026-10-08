/**
 * The bookkeeping that decides how a Run's transcript ends: `run_started`, the
 * one terminal event, and container teardown. Split out of `index.ts` so it
 * can be tested (ADR-0005). Used by `index.ts` (normal flow and signal
 * handlers) and `runAbort.ts` (room-setup refusals).
 */
import { appendEvent, type RunAbortedEvent, type RunCompletedEvent, type RunCompletedByModeratorEvent } from "@agora/shared";

/** A terminal outcome the normal flow hands to `recordOutcome`. Signal-driven cancels go through `closeOutRun` instead. */
export type RunOutcome =
  | { type: "permissionsRefused"; reason: string }
  | { type: "moderatorEnded"; rationale: string; messageId: string }
  | { type: "wallClockExceeded" }
  | { type: "budgetExceeded" };

export interface RunLifecycleDeps {
  /** Root of the per-Run transcript directories; events go to `<logDir>/<runId>/events.jsonl`. */
  logDir: string;
  /** Injected so tests can count teardowns without Docker. */
  composeDown: (composeFile: string) => Promise<void>;
}

/**
 * Owns the bookkeeping that decides how a Run's transcript ends.
 *
 * A Run is ended by exactly one terminal event, and two paths can reach for it:
 * the normal flow and the SIGINT/SIGTERM handler. Ownership is the mutual
 * exclusion — whoever writes the terminal event claims the run, and every other
 * path is a no-op from then on. Without it, a Ctrl-C landing just as the
 * Moderator ends the Run would leave the transcript carrying both a
 * `run_aborted` and a completion, which is worse than either verdict alone.
 *
 * A crash is the case this cannot cover, and deliberately so: nothing can
 * record its own death. What it gets instead is `run_started`, which proves the
 * Run began, so a transcript with no terminal event after it reads as
 * `incomplete`. Where inside the Run it died is left to the agents' own
 * `agent_turn_started`/`agent_turn_ended` pairs and heartbeats; this module
 * writes none of those.
 *
 * Holds one Run at a time: `begin` replaces whatever Run was active.
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

  /** Marks a Run in flight and appends `run_started`. Call before anything that can fail. */
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
   * Whether a Run is still in flight, i.e. no terminal event has been claimed.
   * `superviseRunToTerminal` polls this as its `stopWhen`, so a cancel ends
   * supervision at the next poll rather than letting it go on to report an
   * outcome nobody may record any more.
   *
   * It does not stop the containers: agents and the Moderator can still append
   * events until teardown finishes, so a cancelled transcript may carry a few
   * events after its `run_aborted`.
   */
  function isActive(): boolean {
    return active !== null;
  }

  /**
   * Writes a Run's one terminal event, if this path still owns the run.
   * Returns false, writing nothing, when someone else already closed it out or
   * `runId` is not the Run that `begin` started. The claim is taken before the
   * append, so a concurrent caller loses even while the write is in flight.
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

  /**
   * Records a signal-driven cancellation as `run_aborted` ("cancelled by
   * <signal>") and, if a compose file is attached, tears the containers down.
   * A no-op once the Run is closed out, so a second Ctrl-C (or a cancel after a
   * recorded outcome) neither records a contradictory verdict nor tears down;
   * the normal flow's `finally` owns teardown in that case.
   */
  async function closeOutRun(signal: string): Promise<void> {
    const run = active;
    if (!run) return;
    // No position marker is needed (ADR-0005's `tick: -1` sentinel is gone):
    // events.jsonl is append-only, so where the cancel landed is this event's
    // line position. Its `seq` does not say that, because each writer process
    // numbers its own events.
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
   * Maps a supervised outcome to its terminal event and records it through
   * `recordTerminal`. Returns false when the run is no longer active (already
   * closed out by a concurrent signal or a previous call).
   *
   * `moderatorEnded` writes the runner's own `moderator_ended_run`. The
   * Moderator's container has already appended one (that is what supervision
   * detected), so a completed transcript carries two; this one is the runner's
   * claim on the terminal event. Nothing writes `run_completed` any more.
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
