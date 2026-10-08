/**
 * The runner's view of a live Run, once the containers are up: wait for the
 * agents to report healthy, then watch the transcript until the Run reaches a
 * terminal outcome. The runner never drives the agents; they and the Moderator
 * run their own loops in their containers and talk only through the room, and
 * everything the runner learns comes from `logs/<runId>/events.jsonl`.
 *
 * It decides *that* a Run is over, never records it: the caller (`index.ts`)
 * turns the returned outcome into the terminal event via `runLifecycle.ts`.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioConfig, SequencedEvent, UsageEvent } from "@agora/shared";
import type { BudgetTracker } from "./budget.js";
import { createModeratorWatch, type ModeratorWatch } from "./moderatorWatch.js";
import { createLogger } from "@agora/shared";

const log = createLogger("runner");

/**
 * Polls each agent's `/health` URL in turn until it answers 2xx. `timeoutMs`
 * applies to each URL separately, not to the whole set. Throws on the first
 * URL that misses its deadline. The Moderator exposes no health URL and is not
 * waited on; `createModeratorWatch` flags it later if it never starts.
 */
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
 * Polls the transcript until the Run reaches one of four terminal outcomes and
 * returns it, without writing anything:
 * 1. `moderator_ended` — the Moderator appended `moderator_closing_posted`
 *    (the normal, successful end; the caller then records the terminal
 *    `moderator_ended_run`);
 * 2. `wall_clock_exceeded` — more than `scenario.maxRuntimeMs` has passed since
 *    this call began (the safety backstop);
 * 3. `budget_exceeded` — charged `usage` events put `budget` over its limit;
 * 4. `cancelled` — `stopWhen` returned true (the signal handler has claimed the
 *    Run and records the abort itself).
 *
 * Each poll checks them in the order cancelled, wall clock, Moderator, budget,
 * so a Moderator end that lands after the deadline is reported as a wall-clock
 * timeout. The wall clock starts here, after the containers are healthy, not
 * at `run_started`.
 *
 * While it supervises, it also shows the operator each Moderator Assessment and
 * each failed turn as it lands, and warns if the Moderator goes quiet (see
 * `createModeratorWatch`; injectable for tests).
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

  const pollIntervalMs = 500;

  for (;;) {
    if (stopWhen?.()) {
      return { outcome: "cancelled" };
    }

    const elapsedMs = Date.now() - runtimeStartTime;
    if (elapsedMs > scenario.maxRuntimeMs) {
      return { outcome: "wall_clock_exceeded" };
    }

    try {
      const events = readTranscriptEvents(transcriptPath);

      // Before the terminal check, so the STALE Assessment that ends the Run is
      // shown too.
      moderatorWatch.observe(events);

      for (const event of events) {
        if (event.type === "moderator_closing_posted") {
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

      if (budget.isExceeded()) {
        return { outcome: "budget_exceeded" };
      }
    } catch (err) {
      // readTranscriptEvents already swallows a missing or half-written file;
      // this guards the rest of the poll, so one bad event is logged and
      // retried rather than ending supervision.
      log.error("error reading transcript:", err);
    }

    await sleep(pollIntervalMs);
  }
}

/**
 * Reads every event in a transcript, one JSON object per line.
 *
 * Returns an empty array if the file does not exist yet *or* any line fails to
 * parse, which happens when a poll catches a writer mid-append. Treating that
 * poll as empty is safe: both position counters (budget charging and
 * `moderatorWatch`) only ever move forward, and the next poll sees the
 * completed line.
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
