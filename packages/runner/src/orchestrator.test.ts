import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScenarioConfig } from "@agora/shared";
import { superviseRunToTerminal } from "./orchestrator.js";
import { BudgetTracker } from "./budget.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeScenario(overrides: Partial<ScenarioConfig> = {}): ScenarioConfig {
  return {
    name: "stub",
    topic: "stub",
    seedMessage: "seed",
    maxRuntimeMs: 10000,
    maxToolStepsPerTurn: 4,
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

describe("superviseRunToTerminal", () => {
  test("detects moderator_ended_run event and returns moderator outcome", async () => {
    const logDir = freshLogDir();
    const runId = "mod-run-1";
    const transcriptDir = join(logDir, runId);
    Bun.spawnSync(["mkdir", "-p", transcriptDir]);

    // Write a moderator_ended_run event to the transcript
    writeFileSync(
      join(transcriptDir, "events.jsonl"),
      JSON.stringify({
        seq: 1,
        type: "moderator_ended_run",
        runId,
        rationale: "Discussion concluded naturally",
        messageId: "$event123",
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    const result = await superviseRunToTerminal({
      runId,
      scenario: makeScenario(),
      logDir,
      budget: new BudgetTracker(),
    });

    expect(result).toEqual({
      outcome: "moderator_ended",
      rationale: "Discussion concluded naturally",
      messageId: "$event123",
    });
  });

  test("detects wall-clock timeout and returns wall_clock_exceeded", async () => {
    const logDir = freshLogDir();
    const runId = "wall-run-1";
    const transcriptDir = join(logDir, runId);
    Bun.spawnSync(["mkdir", "-p", transcriptDir]);

    // Create an empty transcript file
    writeFileSync(join(transcriptDir, "events.jsonl"), "");

    const result = await superviseRunToTerminal({
      runId,
      scenario: makeScenario({ maxRuntimeMs: 100 }),
      logDir,
      budget: new BudgetTracker(),
    });

    expect(result.outcome).toBe("wall_clock_exceeded");
  });

  test("detects budget exceeded by reading usage events and returns budget_exceeded", async () => {
    const logDir = freshLogDir();
    const runId = "budget-run-1";
    const transcriptDir = join(logDir, runId);
    Bun.spawnSync(["mkdir", "-p", transcriptDir]);

    // Write usage events that exceed the budget
    const usageLines = [
      { seq: 1, type: "usage", runId, agentId: "a1", promptTokens: 100, completionTokens: 50, timestamp: new Date().toISOString() },
      { seq: 2, type: "usage", runId, agentId: "a2", promptTokens: 100, completionTokens: 50, timestamp: new Date().toISOString() },
    ];
    const content = usageLines.map((e) => JSON.stringify(e)).join("\n") + "\n";
    writeFileSync(join(transcriptDir, "events.jsonl"), content);

    const result = await superviseRunToTerminal({
      runId,
      scenario: makeScenario({ maxRuntimeMs: 10000 }),
      logDir,
      budget: new BudgetTracker(100), // Budget of 100 tokens, but usage exceeds it
    });

    expect(result.outcome).toBe("budget_exceeded");
  });

  test("detects cancellation signal via stopWhen and returns cancelled", async () => {
    const logDir = freshLogDir();
    const runId = "cancel-run-1";
    const transcriptDir = join(logDir, runId);
    Bun.spawnSync(["mkdir", "-p", transcriptDir]);

    // Create an empty transcript file
    writeFileSync(join(transcriptDir, "events.jsonl"), "");

    let shouldStop = false;
    const result = await superviseRunToTerminal({
      runId,
      scenario: makeScenario({ maxRuntimeMs: 10000 }),
      logDir,
      budget: new BudgetTracker(),
      stopWhen: () => {
        if (!shouldStop) {
          shouldStop = true;
          return false; // First check, don't stop yet
        }
        return true; // Second check, stop now
      },
    });

    expect(result.outcome).toBe("cancelled");
  });

  test("avoids double-counting usage events across multiple transcript reads", async () => {
    const logDir = freshLogDir();
    const runId = "double-count-1";
    const transcriptDir = join(logDir, runId);
    Bun.spawnSync(["mkdir", "-p", transcriptDir]);

    // Write a single usage event
    writeFileSync(
      join(transcriptDir, "events.jsonl"),
      JSON.stringify({
        seq: 1,
        type: "usage",
        runId,
        agentId: "a1",
        promptTokens: 40,
        completionTokens: 20,
        timestamp: new Date().toISOString(),
      }) + "\n",
    );

    let checkCount = 0;
    const budget = new BudgetTracker(100); // Budget of 100 tokens
    const result = await superviseRunToTerminal({
      runId,
      scenario: makeScenario({ maxRuntimeMs: 60000 }),
      logDir,
      budget,
      stopWhen: () => {
        checkCount++;
        // After we've polled a few times, check that the budget was only charged once
        // for the single usage event (40 + 20 = 60 tokens)
        if (checkCount >= 2) {
          return true; // Stop after multiple polls
        }
        return false;
      },
    });

    expect(result.outcome).toBe("cancelled");
    // Verify budget tracked exactly 60 tokens (one reading of one event), not 120 (double-counted)
    const summary = budget.summary();
    expect(summary.totalTokens).toBe(60);
  });
});
