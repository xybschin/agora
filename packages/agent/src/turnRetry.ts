/**
 * The outer retry policy for a failed Turn, shared by the agent loop
 * (loop.ts) and the Moderator (moderator.ts).
 */
import type { Logger } from "@agora/shared";

/**
 * Bounds on re-running a Turn that threw. chatCompletion already waits out
 * provider blips inside a turn (see llm.ts `RetryOptions`); this is the outer
 * net for a failure that outlasted those retries. Without it the loop would go
 * back to waiting for new room activity, which in a fresh room where nobody
 * has spoken never arrives (the stall in run abortion-policy-20261007-0937).
 *
 * After the first failure the turn is re-run up to `maxRetries` times, the
 * n-th re-run after `baseDelayMs * 2^(n-1)`, each delay capped at
 * `maxDelayMs`. Past the cap the loop resumes waiting, so a persistently-down
 * provider cannot spin an agent forever. `sleep` exists so tests can drive the
 * timing.
 */
export interface TurnRetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_TURN_RETRY: TurnRetryOptions = {
  maxRetries: 3,
  baseDelayMs: 15_000,
  maxDelayMs: 60_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Runs `attempt` until it succeeds or the retry cap is hit. Every failure is
 * handed to `onFailure` (which records it as `agent_turn_failed`) before the
 * backoff, so the event log shows each failed attempt, not just the last.
 * `canRetry` is asked after each failure: a turn that already posted to the
 * room has acted on its activity, and re-running it would post twice.
 * Returns the turn's result, or undefined once the loop gives up.
 */
export async function runTurnWithRetry<T>(
  log: Logger,
  retry: TurnRetryOptions,
  attempt: () => Promise<T>,
  onFailure: (err: unknown) => Promise<void>,
  canRetry: () => boolean,
): Promise<T | undefined> {
  for (let n = 0; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      await onFailure(err);
      if (!canRetry()) {
        log.warn("the failed turn already posted; not retrying it");
        return undefined;
      }
      if (n >= retry.maxRetries) {
        log.error(`turn retries exhausted (${retry.maxRetries}); will resume waiting`);
        return undefined;
      }
      const delay = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** n);
      log.warn(`retrying the turn (${n + 1}/${retry.maxRetries}) in ${delay}ms`);
      await retry.sleep(delay);
    }
  }
}
