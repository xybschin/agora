import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioConfig, SequencedEvent, UsageEvent } from "@agora/shared";
import type { BudgetTracker } from "./budget.js";
import { createModeratorWatch, type ModeratorWatch } from "./moderatorWatch.js";

export async function waitForHealth(urls: string[], timeoutMs = 60_000): Promise<void> {
  for (const url of urls) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(url);
        if (res.ok) break;
      } catch {
        // not up yet, keep polling
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${url} to become healthy`);
      }
      await sleep(1000);
    }
  }
}

/**
 * Supervises a Run to its terminal outcome by monitoring the transcript for four
 * conditions:
 * 1. Moderator ending the Run (moderator_ended_run event) → successful completion
 * 2. Wall-clock runtime limit exceeded → aborted (safety backstop)
 * 3. Token budget exceeded → aborted (unchanged from before, now tracked via transcript)
 * 4. Operator cancellation (SIGINT/SIGTERM) → aborted (unchanged)
 *
 * Agents run their own continuous loops independently, driven by Matrix activity.
 * The runner's job is to detect when the Run reaches one of these four terminal
 * conditions and return control to the caller to write the terminal event and tear down.
 *
 * While it supervises, it also shows the operator each Moderator Assessment as it
 * lands and warns if the Moderator goes quiet (see `createModeratorWatch`).
 *
 * `stopWhen` is checked periodically while supervising (not just at intervals):
 * a cancel is recorded as `cancelled` when detected, and control returns to the caller
 * so the signal handler can write the terminal event.
 */
export async function superviseRunToTerminal(params: {
  runId: string;
  scenario: ScenarioConfig;
  logDir: string;
  budget: BudgetTracker;
  stopWhen?: () => boolean;
  moderatorWatch?: ModeratorWatch;
}): Promise<
  | { outcome: "moderator_ended"; rationale: string; messageId: string }
  | { outcome: "wall_clock_exceeded" }
  | { outcome: "budget_exceeded" }
  | { outcome: "cancelled" }
> {
  const { runId, scenario, logDir, budget, stopWhen } = params;
  const moderatorWatch = params.moderatorWatch ?? createModeratorWatch();
  const runtimeStartTime = Date.now();
  const transcriptPath = join(logDir, runId, "events.jsonl");

  // How many transcript lines have already been charged to the budget, so a
  // re-read never charges a usage event twice. Keyed by position, not seq:
  // every container numbers its own events from 1, so seq repeats within a Run
  // and deduping on it silently dropped real spend (agora-6s2.6). Position is
  // safe because events.jsonl is append-only.
  let chargedLines = 0;

  const pollIntervalMs = 500; // Poll transcript every 500ms

  for (;;) {
    // Check for cancellation signal at the top of each poll cycle.
    if (stopWhen?.()) {
      return { outcome: "cancelled" };
    }

    // Check wall-clock runtime limit.
    const elapsedMs = Date.now() - runtimeStartTime;
    if (elapsedMs > scenario.maxRuntimeMs) {
      return { outcome: "wall_clock_exceeded" };
    }

    // Read the transcript and check for terminal events.
    try {
      const events = readTranscriptEvents(transcriptPath);

      // Before the terminal check, so the STALE Assessment that ends the Run is
      // shown too.
      moderatorWatch.observe(events);

      // Check for moderator_ended_run (successful completion).
      for (const event of events) {
        if (event.type === "moderator_ended_run") {
          return {
            outcome: "moderator_ended",
            rationale: event.rationale,
            messageId: event.messageId,
          };
        }
      }

      // Charge the usage events appended since the last read.
      for (const event of events.slice(chargedLines)) {
        if (event.type === "usage") {
          budget.record({
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          });
        }
      }
      chargedLines = Math.max(chargedLines, events.length);

      // Check for budget exceeded.
      if (budget.isExceeded()) {
        return { outcome: "budget_exceeded" };
      }
    } catch (err) {
      // Transcript file may not exist yet or may not be readable; keep polling.
      console.error("error reading transcript:", err);
    }

    // Sleep before the next poll.
    await sleep(pollIntervalMs);
  }
}

/**
 * Read all events from a transcript file, parsing each line as JSON.
 * Returns an empty array if the file doesn't exist.
 */
function readTranscriptEvents(transcriptPath: string): SequencedEvent[] {
  try {
    const content = readFileSync(transcriptPath, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as SequencedEvent);
  } catch {
    return [];
  }
}
