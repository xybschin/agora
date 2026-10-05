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
      expect.objectContaining({ type: "run_started", runId: "r1", seq: expect.any(Number) }),
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
      timestamp: "t",
    });
    const second = await lifecycle.recordTerminal("r1", {
      type: "run_aborted",
      runId: "r1",
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
        timestamp: "t",
      }),
    ]);

    const terminal = readEvents(logDir, "r1").filter((e) => e.type !== "run_started");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toEqual(
      expect.objectContaining({ type: "run_aborted", reason: "cancelled by SIGINT" }),
    );
  });

  test("a cancel records run_aborted with its own seq, and no tick-based sentinel", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    await lifecycle.closeOutRun("SIGTERM");

    const events = readEvents(logDir, "r1");
    const started = events.find((e) => e.type === "run_started");
    const abort = events.find((e) => e.type === "run_aborted");
    // The old `tick: -1` sentinel is gone: where the cancel landed in the
    // stream is carried by the event's own monotonic seq (its seq is after the
    // run_started that preceded it), and deriveRunStatus no longer reads a tick
    // off the abort.
    expect(abort).toEqual(expect.objectContaining({ type: "run_aborted" }));
    expect(abort).not.toHaveProperty("tick");
    expect(Number(abort?.seq)).toBeGreaterThan(Number(started?.seq));
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
      timestamp: "t",
    });

    expect(claimed).toBe(false);
  });
});

describe("run lifecycle outcomes", () => {
  test("a permissions-refusal outcome records run_aborted with the permission error message", async () => {
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
        reason: "agents were denied write access",
      }),
    );
  });

  test("a budget-exceeded outcome records run_aborted with budget reason", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "budgetExceeded",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const abort = events.find((e) => e.type === "run_aborted");
    expect(abort).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        reason: "token budget exceeded",
      }),
    );
  });

  test("a wall-clock-exceeded outcome records run_aborted with wall-clock reason", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "wallClockExceeded",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const abort = events.find((e) => e.type === "run_aborted");
    expect(abort).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        reason: "wall-clock runtime limit exceeded",
      }),
    );
  });

  test("a moderator-ended outcome records moderator_ended_run with rationale", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "moderatorEnded",
      rationale: "Discussion concluded",
      messageId: "$event_123",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const ended = events.find((e) => e.type === "moderator_ended_run");
    expect(ended).toEqual(
      expect.objectContaining({
        type: "moderator_ended_run",
        rationale: "Discussion concluded",
        messageId: "$event_123",
      }),
    );
  });

  test("a permissions-refused outcome records run_aborted with reason", async () => {
    const logDir = freshLogDir();
    const { composeDown } = stubComposeDown();
    const lifecycle = createRunLifecycle({ logDir, composeDown });
    await lifecycle.begin("r1");

    const claimed = await lifecycle.recordOutcome("r1", {
      type: "permissionsRefused",
      reason: "setup account permissions insufficient",
    });

    expect(claimed).toBe(true);
    const events = readEvents(logDir, "r1");
    const abort = events.find((e) => e.type === "run_aborted");
    expect(abort).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        reason: "setup account permissions insufficient",
      }),
    );
  });
});
