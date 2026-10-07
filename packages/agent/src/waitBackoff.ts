/**
 * Pacing for re-polling after a failed wait for room activity. A wait fails
 * fast when there is nothing to talk to -- ConnectionRefused while mcp_server
 * is still starting -- and re-polling immediately wrote ~240 heartbeats in
 * half a second per agent. Instead the n-th consecutive failure waits
 * `baseDelayMs * 2^(n-1)`, capped at `maxDelayMs`, before the loop polls
 * again; a successful wait resets the count. Unlike TurnRetryOptions there is
 * no retry cap: waiting is what the loop is for, so it never gives up on the
 * room. `sleep` exists so tests can drive the timing.
 */
export interface WaitBackoffOptions {
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_WAIT_BACKOFF: WaitBackoffOptions = {
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The delay before re-polling after `failures` consecutive failed waits (1-based). */
export function waitBackoffDelay(backoff: WaitBackoffOptions, failures: number): number {
  return Math.min(backoff.maxDelayMs, backoff.baseDelayMs * 2 ** (failures - 1));
}
