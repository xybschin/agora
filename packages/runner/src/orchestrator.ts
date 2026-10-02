import { setTimeout as sleep } from "node:timers/promises";
import type { ScenarioConfig } from "@agora/shared";
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
 * The orchestrator no longer writes any per-tick event boundary: per-agent
 * liveness is recorded by the agent loops themselves, as
 * `agent_turn_started`/`agent_turn_ended` pairs (each bracketing one agent's
 * turn) plus `agent_heartbeat`. `ticksRun` remains this module's return
 * value — runner-level bookkeeping that the caller logs and folds into the
 * Run outcome — but it is no longer stamped onto any event. Event ordering is
 * carried by the per-event `seq` the event-log writer assigns at write time:
 * monotonic per runId within a single writing process. It is deliberately not
 * a perfect global order across the runner and every concurrently-writing
 * container (see the always-active ADR) — it is enough to reconstruct the
 * order any one writer produced, which is what the removed global tick
 * bracket previously gave per tick.
 *
 * `stopWhen` is polled at the top of each tick, not inside one: a cancel is
 * delivered asynchronously while a tick's requests are in flight, and ending
 * between ticks keeps the orchestrator from launching a fresh round after the
 * terminal event has been recorded.
 */
export async function runTicks(params: {
  scenario: ScenarioConfig;
  agentPorts: Record<string, number>;
  budget: BudgetTracker;
  stopWhen?: () => boolean;
}): Promise<{ aborted: boolean; reason?: string; ticksRun: number }> {
  const { scenario, agentPorts, budget, stopWhen } = params;
  const agentIds = Object.keys(agentPorts);

  for (let tick = 1; tick <= scenario.ticks; tick++) {
    if (stopWhen?.()) {
      // The signal handler owns writing the terminal event; returning aborted
      // here stops the loop and makes the runner's own branch agree, while
      // recordTerminal declines to write a second one.
      return { aborted: true, reason: "cancelled", ticksRun: tick - 1 };
    }

    console.log(`--- tick ${tick}/${scenario.ticks} ---`);

    const results = await Promise.allSettled(
      agentIds.map(async (agentId) => {
        const port = agentPorts[agentId];
        const res = await fetch(`http://localhost:${port}/tick`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // totalTicks lets the agent ground "tick N of M" in its per-tick
          // message; the runner owns the Scenario's tick count.
          body: JSON.stringify({ tick, totalTicks: scenario.ticks }),
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

    // The budget check is the only post-tick bookkeeping left here: a Run that
    // stops on budget is a Run that finished this tick, and the terminal event
    // (written by the caller via recordOutcome) records the outcome.
    if (budget.isExceeded()) {
      return { aborted: true, reason: "budget exceeded", ticksRun: tick };
    }

    if (tick < scenario.ticks) {
      await sleep(scenario.tickIntervalMs);
    }
  }

  return { aborted: false, ticksRun: scenario.ticks };
}
