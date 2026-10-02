import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioConfig } from "@agora/shared";
import { deriveRunStatus } from "@agora/shared";
import { appendEvent } from "@agora/shared";
import { runTicks } from "./orchestrator.js";
import { BudgetTracker } from "./budget.js";
import { createRunLifecycle } from "./runLifecycle.js";

const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stands in for one agent container. The real agent appends its own `usage`/
 * `stance`/turn events to the shared log before it responds, so the stub does
 * the same via the real appendEvent (which stamps each event's `seq`).
 */
async function startStubAgent(opts: {
  logDir: string;
  runId: string;
  agentId: string;
  onTick?: () => void;
}): Promise<number> {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const { tick } = (await req.json()) as { tick: number };
      opts.onTick?.();
      await appendEvent(opts.logDir, opts.runId, {
        type: "usage",
        runId: opts.runId,
        agentId: opts.agentId,
        promptTokens: 10,
        completionTokens: 5,
        timestamp: new Date().toISOString(),
      });
      // The real agent returns the tick's usage on its response body, which is
      // where the orchestrator reads it for the budget.
      return Response.json({
        ok: true,
        agentId: opts.agentId,
        tick,
        usage: { promptTokens: 10, completionTokens: 5 },
      });
    },
  });
  servers.push(server);
  if (server.port === undefined) throw new Error("stub agent bound no port");
  return server.port;
}

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    name: "stub",
    topic: "stub",
    seedMessage: "seed",
    ticks: 2,
    tickIntervalMs: 0,
    maxToolStepsPerTick: 4,
    memory: { windowSize: 10 },
    budget: { maxTotalTokens: undefined },
    agents: [],
    ...overrides,
  } as ScenarioConfig;
}

function freshLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agora-orch-"));
  dirs.push(dir);
  return dir;
}

/** Stripped to the two fields the assertions care about, so `toEqual` is exact. */
function readEvents(logDir: string, runId: string): { type: string }[] {
  return readFileSync(join(logDir, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { type: string };
      return { type: event.type };
    });
}

describe("runTicks event writing", () => {
  test("writes no per-tick boundary events of its own", async () => {
    // The orchestrator's only event responsibility is gone: per-agent liveness
    // now comes from the agents' own turn/heartbeat events (asserted in the
    // agent loop tests), so runTicks must leave the log free of tick_start/
    // tick_end.
    const logDir = freshLogDir();
    const runId = "stub-run-1";
    const port = await startStubAgent({ logDir, runId, agentId: "a" });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 2 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
    });

    expect(result).toEqual({ aborted: false, ticksRun: 2 });
    const types = readEvents(logDir, runId).map((e) => e.type);
    expect(types).toEqual(["usage", "usage"]);
    expect(types).not.toContain("tick_start");
    expect(types).not.toContain("tick_end");
  });

  test("records the tick it aborted on as one tick run when the budget is blown", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-3";
    // Each agent costs 15 tokens a tick, so a cap of 10 is blown on tick 1
    // and never on a later one.
    const port = await startStubAgent({ logDir, runId, agentId: "a" });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 5 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(10),
    });

    expect(result).toEqual({ aborted: true, reason: "budget exceeded", ticksRun: 1 });
  });
});

describe("runTicks cancellation", () => {
  test("stops at the next tick boundary once stopWhen trips", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-4";
    let ticksRun = 0;
    const port = await startStubAgent({
      logDir,
      runId,
      agentId: "a",
      onTick: () => void ticksRun++,
    });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 5 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
      stopWhen: () => ticksRun >= 1,
    });

    expect(result).toEqual({ aborted: true, reason: "cancelled", ticksRun: 1 });
    // Only tick 1's single usage event landed.
    expect(readEvents(logDir, runId).map((e) => e.type)).toEqual(["usage"]);
  });

  test("a cancel leaves the orchestrator from launching a fresh round after the abort", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-5";
    let cancelledMidTick = false;
    const port = await startStubAgent({
      logDir,
      runId,
      agentId: "a",
      onTick: () => void (cancelledMidTick = true),
    });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 3 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
      stopWhen: () => cancelledMidTick,
    });

    expect(result).toEqual({ aborted: true, reason: "cancelled", ticksRun: 1 });
    expect(readEvents(logDir, runId)).toHaveLength(1);
  });
});

describe("full run lifecycle", () => {
  test("a run that completes derives status correctly from the transcript on disk", async () => {
    const logDir = freshLogDir();
    const runId = "full-run-1";
    const port = await startStubAgent({ logDir, runId, agentId: "agent1" });
    const composeDown = async () => {};
    const lifecycle = createRunLifecycle({ logDir, composeDown });

    await lifecycle.begin(runId);

    const tickResult = await runTicks({
      scenario: makeScenario({ ticks: 3 }),
      agentPorts: { agent1: port },
      budget: new BudgetTracker(),
    });

    expect(tickResult).toEqual({ aborted: false, ticksRun: 3 });

    const success = await lifecycle.recordTerminal(runId, {
      type: "run_completed",
      runId,
      timestamp: new Date().toISOString(),
    });
    expect(success).toBe(true);

    // Read the transcript back from disk and derive the status.
    const events = readFileSync(join(logDir, runId, "events.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const derived = deriveRunStatus(events as never, 3);
    expect(derived).toEqual({ status: "completed" });
  });

  test("tick loop still completes when all agents are unreachable", async () => {
    const logDir = freshLogDir();
    const runId = "full-run-2";
    // Use a port that is definitely not listening.
    const deadPort = 1;
    const composeDown = async () => {};
    const lifecycle = createRunLifecycle({ logDir, composeDown });

    await lifecycle.begin(runId);

    const tickResult = await runTicks({
      scenario: makeScenario({ ticks: 3 }),
      agentPorts: { agent1: deadPort },
      budget: new BudgetTracker(),
    });

    // The run should have completed all ticks despite agent failures, and no
    // agent event should have landed (the unreachable agent wrote nothing).
    expect(tickResult).toEqual({ aborted: false, ticksRun: 3 });
    expect(readEvents(logDir, runId).map((e) => e.type)).toEqual(["run_started"]);

    const success = await lifecycle.recordTerminal(runId, {
      type: "run_completed",
      runId,
      timestamp: new Date().toISOString(),
    });
    expect(success).toBe(true);
  });
});
