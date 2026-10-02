import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent } from "./eventLog.js";
import type { SequencedEvent } from "./events.js";

let tempDir: string;

async function makeLogDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(tmpdir(), "agora-eventlog-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

async function readEvents(logDir: string, runId: string): Promise<SequencedEvent[]> {
  const text = await readFile(path.join(logDir, runId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SequencedEvent);
}

describe("appendEvent seq assignment", () => {
  test("assigns a monotonic seq that increments across sequential writes for a runId", async () => {
    const logDir = await makeLogDir();
    // The seq counter is keyed per runId and lives for the process, so each
    // test uses its own runId and asserts absolute seqs only within it.
    const runId = "run-seq-inc";

    await appendEvent(logDir, runId, { type: "run_started", runId, timestamp: "t1" });
    await appendEvent(logDir, runId, {
      type: "stance",
      runId,
      agentId: "a",
      stance: 0,
      timestamp: "t2",
    });
    await appendEvent(logDir, runId, { type: "run_completed", runId, timestamp: "t3" });

    const ids = (await readEvents(logDir, runId)).map((e) => e.seq);
    expect(ids).toEqual([1, 2, 3]);
  });

  test("gives two different runIds independent counters", async () => {
    const logDir = await makeLogDir();

    await appendEvent(logDir, "run-a-only", { type: "run_started", runId: "run-a-only", timestamp: "t" });
    await appendEvent(logDir, "run-a-only", {
      type: "stance",
      runId: "run-a-only",
      agentId: "a",
      stance: 0,
      timestamp: "t",
    });
    await appendEvent(logDir, "run-b-only", { type: "run_started", runId: "run-b-only", timestamp: "t" });

    const a = await readEvents(logDir, "run-a-only");
    const b = await readEvents(logDir, "run-b-only");
    expect(a.map((e) => e.seq)).toEqual([1, 2]);
    expect(b.map((e) => e.seq)).toEqual([1]);
  });

  test("stamps seq onto every event type written through the log", async () => {
    const logDir = await makeLogDir();
    const runId = "run-all-types";

    await appendEvent(logDir, runId, {
      type: "agent_turn_started",
      runId,
      agentId: "a",
      turn: 1,
      timestamp: "t",
    });
    await appendEvent(logDir, runId, {
      type: "message",
      runId,
      agentId: "a",
      matrixEventId: "$ev",
      roomId: "!r",
      content: "hi",
      timestamp: "t",
    });
    await appendEvent(logDir, runId, {
      type: "agent_heartbeat",
      runId,
      agentId: "moderator",
      state: "active",
      timestamp: "t",
    });

    const events = await readEvents(logDir, runId);
    expect(events.map((e) => [e.type, e.seq])).toEqual([
      ["agent_turn_started", 1],
      ["message", 2],
      ["agent_heartbeat", 3],
    ]);
  });
});
