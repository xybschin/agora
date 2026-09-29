import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioConfig } from "@agora/shared";
import { runTicks } from "./orchestrator.js";
import { BudgetTracker } from "./budget.js";

const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Stands in for one agent container. The real agent appends its own `usage`/
 * `stance` events to the shared log before it responds, so the stub does the
 * same — that ordering is what makes `tick_end` a reliable "this tick's events
 * are all on disk" marker.
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
      await appendStubEvent(opts.logDir, opts.runId, opts.agentId, tick);
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

async function appendStubEvent(
  logDir: string,
  runId: string,
  agentId: string,
  tick: number,
): Promise<void> {
  const { appendFile, mkdir } = await import("node:fs/promises");
  const path = await import("node:path");
  const dir = path.join(logDir, runId);
  await mkdir(dir, { recursive: true });
  await appendFile(
    path.join(dir, "events.jsonl"),
    JSON.stringify({
      type: "usage",
      runId,
      tick,
      agentId,
      promptTokens: 10,
      completionTokens: 5,
      timestamp: new Date().toISOString(),
    }) + "\n",
    "utf8",
  );
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
function readEvents(logDir: string, runId: string): { type: string; tick: number }[] {
  return readFileSync(join(logDir, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { type: string; tick: number };
      return { type: event.type, tick: event.tick };
    });
}

function boundaries(events: { type: string; tick: number }[]): { type: string; tick: number }[] {
  return events.filter((e) => e.type.startsWith("tick_"));
}

describe("runTicks tick boundaries", () => {
  test("brackets every tick with tick_start and tick_end", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-1";
    const port = await startStubAgent({ logDir, runId, agentId: "a" });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 2 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
      runId,
      logDir,
    });

    expect(result).toEqual({ aborted: false, ticksRun: 2 });
    expect(boundaries(readEvents(logDir, runId))).toEqual([
      { type: "tick_start", tick: 1 },
      { type: "tick_end", tick: 1 },
      { type: "tick_start", tick: 2 },
      { type: "tick_end", tick: 2 },
    ]);
  });

  test("writes tick_end after the agents' own events for that tick", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-2";
    const port = await startStubAgent({ logDir, runId, agentId: "a" });

    await runTicks({
      scenario: makeScenario({ ticks: 1 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
      runId,
      logDir,
    });

    expect(readEvents(logDir, runId).map((e) => e.type)).toEqual([
      "tick_start",
      "usage",
      "tick_end",
    ]);
  });

  test("still closes the tick it aborted on, so a budget stop is bracketed", async () => {
    const logDir = freshLogDir();
    const runId = "stub-run-3";
    // Each agent costs 15 tokens a tick, so a cap of 10 is blown on tick 1
    // and never on a later one.
    const port = await startStubAgent({ logDir, runId, agentId: "a" });

    const result = await runTicks({
      scenario: makeScenario({ ticks: 5 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(10),
      runId,
      logDir,
    });

    expect(result).toEqual({ aborted: true, reason: "budget exceeded", ticksRun: 1 });
    expect(boundaries(readEvents(logDir, runId)).map((e) => e.type)).toEqual([
      "tick_start",
      "tick_end",
    ]);
  });
});

describe("runTicks cancellation", () => {
  test("stops at the next tick boundary once stopWhen trips", async () => {
    // The bug this guards: a cancel delivered while tick N's requests are in
    // flight used to let the loop carry on and land a partial tick N+1 bracket
    // *after* the terminal event, so the transcript no longer ended on one.
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
      runId,
      logDir,
      stopWhen: () => ticksRun >= 1,
    });

    expect(result).toEqual({ aborted: true, reason: "cancelled", ticksRun: 1 });
    expect(boundaries(readEvents(logDir, runId))).toEqual([
      { type: "tick_start", tick: 1 },
      { type: "tick_end", tick: 1 },
    ]);
  });

  test("leaves no tick bracket unclosed when cancelled mid-tick", async () => {
    // A cancel arrives while tick 1's requests are in flight. The tick is not
    // abandoned — abandoning it would strand a `tick_start` with no `tick_end`
    // — so it finishes, and the loop stops at the next boundary. The invariant
    // is that every `tick_start` has a matching `tick_end`.
    const logDir = freshLogDir();
    const runId = "stub-run-5";
    let cancelledMidTick = false;
    const port = await startStubAgent({
      logDir,
      runId,
      agentId: "a",
      onTick: () => void (cancelledMidTick = true),
    });

    await runTicks({
      scenario: makeScenario({ ticks: 3 }),
      agentPorts: { a: port },
      budget: new BudgetTracker(),
      runId,
      logDir,
      stopWhen: () => cancelledMidTick,
    });

    const events = readEvents(logDir, runId);
    const starts = events.filter((e) => e.type === "tick_start").map((e) => e.tick);
    const ends = events.filter((e) => e.type === "tick_end").map((e) => e.tick);
    expect(starts).toEqual(ends);
    expect(events.at(-1)).toEqual({ type: "tick_end", tick: 1 });
  });
});
