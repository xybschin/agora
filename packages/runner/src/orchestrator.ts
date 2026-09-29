import { setTimeout as sleep } from "node:timers/promises";
import { appendEvent, type ScenarioConfig } from "@agora/shared";
import type { BudgetTracker } from "./budget.js";

interface TickResponse {
  ok: boolean;
  agentId: string;
  tick: number;
  stance?: number;
  usage?: { promptTokens: number; completionTokens: number };
  error?: string;
}

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
 * Drives fixed-tick, round-based scheduling (Q5): every tickIntervalMs, POST
 * /tick to every agent in parallel (Q22) and wait for all to finish before
 * advancing, so ticks stay a well-defined timestep for the stance metric.
 *
 * Each tick is bracketed by `tick_start`/`tick_end` in the Transcript, so a Run
 * that died mid-tick is distinguishable from one that died between ticks. The
 * boundaries land either side of `Promise.allSettled`, which is sound because an
 * agent appends its `usage`/`stance`/`message` events before it responds, so
 * every event for tick N is already on disk by the time allSettled settles.
 *
 * `stopWhen` is polled at the top of each tick, not inside one: a cancel is
 * delivered asynchronously while a tick's requests are in flight, and the tick
 * cannot be abandoned mid-write without leaving an unclosed bracket. Ending
 * between ticks instead keeps the transcript's last event a terminal one.
 */
export async function runTicks(params: {
  scenario: ScenarioConfig;
  agentPorts: Record<string, number>;
  budget: BudgetTracker;
  runId: string;
  logDir: string;
  stopWhen?: () => boolean;
}): Promise<{ aborted: boolean; reason?: string; ticksRun: number }> {
  const { scenario, agentPorts, budget, runId, logDir, stopWhen } = params;
  const agentIds = Object.keys(agentPorts);

  for (let tick = 1; tick <= scenario.ticks; tick++) {
    if (stopWhen?.()) {
      // The signal handler owns writing the terminal event; returning aborted
      // here stops the loop and makes the runner's own branch agree, while
      // recordTerminal declines to write a second one.
      return { aborted: true, reason: "cancelled", ticksRun: tick - 1 };
    }

    console.log(`--- tick ${tick}/${scenario.ticks} ---`);

    await appendEvent(logDir, runId, {
      type: "tick_start",
      runId,
      tick,
      timestamp: new Date().toISOString(),
    });

    const results = await Promise.allSettled(
      agentIds.map(async (agentId) => {
        const port = agentPorts[agentId];
        const res = await fetch(`http://localhost:${port}/tick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tick }),
        });
        return (await res.json()) as TickResponse;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value.usage) budget.record(result.value.usage);
        if (!result.value.ok) console.error("agent tick error:", result.value);
      } else {
        console.error("tick request failed:", result.reason);
      }
    }

    // Written before the budget check so an abort is bracketed by the tick that
    // caused it — a Run that stops on budget is a Run that finished a tick.
    await appendEvent(logDir, runId, {
      type: "tick_end",
      runId,
      tick,
      timestamp: new Date().toISOString(),
    });

    if (budget.isExceeded()) {
      return { aborted: true, reason: "budget exceeded", ticksRun: tick };
    }

    if (tick < scenario.ticks) {
      await sleep(scenario.tickIntervalMs);
    }
  }

  return { aborted: false, ticksRun: scenario.ticks };
}
