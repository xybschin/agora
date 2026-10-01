import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLifecycle } from "./runLifecycle.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agora-lifecycle-"));
  dirs.push(dir);
  return dir;
}

function readEvents(logDir: string, runId: string): Record<string, unknown>[] {
  return readFileSync(join(logDir, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Records how many times teardown was actually invoked. */
function stubComposeDown() {
  const calls: string[] = [];
  return { calls, composeDown: async (file: string) => void calls.push(file) };
}

describe("run lifecycle terminal events", () => {
  test("begin records run_started so a bare transcript is identifiable", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });

    await lifecycle.begin("r1");

    expect(readEvents(logDir, "r1")).toEqual([
      expect.objectContaining({ type: "run_started", runId: "r1", tick: 0 }),
    ]);
  });

  test("recordTerminal claims the run, so a second verdict is refused", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const first = await lifecycle.recordTerminal("r1", {
      type: "run_completed",
      runId: "r1",
      tick: 5,
      timestamp: "t",
    });
    const second = await lifecycle.recordTerminal("r1", {
      type: "run_aborted",
      runId: "r1",
      tick: 5,
      reason: "cancelled by SIGTERM",
      timestamp: "t",
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    const terminal = readEvents(logDir, "r1").filter((e) =>
      String(e.type).startsWith("run_") && e.type !== "run_started",
    );
    expect(terminal).toEqual([
      expect.objectContaining({ type: "run_completed" }),
    ]);
  });

  test("a cancel racing the normal path yields one run_aborted, not both", async () => {
    // The bug this guards: SIGINT during the last tick lets the signal handler
    // and main() both reach for a terminal event, which used to leave the
    // transcript carrying a run_aborted and a run_completed at once.
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    await Promise.all([
      lifecycle.closeOutRun("SIGINT"),
      lifecycle.recordTerminal("r1", {
        type: "run_completed",
        runId: "r1",
        tick: 5,
        timestamp: "t",
      }),
    ]);

    const terminal = readEvents(logDir, "r1").filter((e) => e.type !== "run_started");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toEqual(
      expect.objectContaining({ type: "run_aborted", reason: "cancelled by SIGINT" }),
    );
  });

  test("a cancel records tick -1 so it cannot lower the tick count already on disk", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");
    // Stand in for tick 4's events having already landed.
    const { appendFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(logDir, "r1"), { recursive: true });
    await appendFile(
      join(logDir, "r1", "events.jsonl"),
      JSON.stringify({
        type: "usage",
        runId: "r1",
        tick: 4,
        agentId: "a",
        promptTokens: 1,
        completionTokens: 1,
        timestamp: "t",
      }) + "\n",
      "utf8",
    );

    await lifecycle.closeOutRun("SIGTERM");

    const abort = readEvents(logDir, "r1").find((e) => e.type === "run_aborted");
    expect(abort).toEqual(expect.objectContaining({ type: "run_aborted", tick: -1 }));
    // deriveRunStatus takes the max tick across events, so the sentinel cannot
    // pull the reported tick count below what tick 4 already established.
    const ticks = readEvents(logDir, "r1").map((e) => Number(e.tick));
    expect(Math.max(...ticks)).toBe(4);
  });

  test("a cancel before the compose file exists records but does not tear down", async () => {
    const logDir = freshLogDir();
    const { calls, composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    await lifecycle.closeOutRun("SIGINT");

    expect(readEvents(logDir, "r1").some((e) => e.type === "run_aborted")).toBe(true);
    expect(calls).toEqual([]);
  });

  test("teardown is memoised so a cancel and the finally block do not double it", async () => {
    const logDir = freshLogDir();
    const { calls, composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");
    lifecycle.attachComposeFile("/tmp/fake-compose.yml");

    await Promise.all([
      lifecycle.closeOutRun("SIGTERM"),
      lifecycle.teardownContainers("/tmp/fake-compose.yml"),
      lifecycle.teardownContainers("/tmp/fake-compose.yml"),
    ]);

    expect(calls).toEqual(["/tmp/fake-compose.yml"]);
  });

  test("closeOutRun is a no-op once the run is already closed out", async () => {
    const logDir = freshLogDir();
    const { calls, composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");
    lifecycle.attachComposeFile("/tmp/fake-compose.yml");
    await lifecycle.closeOutRun("SIGINT");
    calls.length = 0;

    // A second Ctrl-C must not record a contradictory verdict or re-tear-down.
    await lifecycle.closeOutRun("SIGINT");

    const terminal = readEvents(logDir, "r1").filter((e) => e.type !== "run_started");
    expect(terminal).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  test("recordTerminal refuses a runId that never began", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });

    const claimed = await lifecycle.recordTerminal("never-started", {
      type: "run_completed",
      runId: "never-started",
      tick: 1,
      timestamp: "t",
    });

    expect(claimed).toBe(false);
  });
});

describe("run lifecycle outcomes", () => {
  test("a permissions-refusal outcome records run_aborted with tick 0 and the permission error message", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "permissionsRefused",
      reason: "agents were denied write access",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const abort = events.find((e) => e.type === "run_aborted");
    expect(abort).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        tick: 0,
        reason: "agents were denied write access",
      }),
    );
  });

  test("a ticks-aborted outcome records run_aborted with the reported reason and ticksRun", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "ticksAborted",
      ticksRun: 3,
      reason: "budget exceeded",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const abort = events.find((e) => e.type === "run_aborted");
    expect(abort).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        tick: 3,
        reason: "budget exceeded",
      }),
    );
  });

  test("a completed outcome records run_completed with ticksRun", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "completed",
      ticksRun: 5,
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const completed = events.find((e) => e.type === "run_completed");
    expect(completed).toEqual(
      expect.objectContaining({
        type: "run_completed",
        tick: 5,
      }),
    );
  });
});
