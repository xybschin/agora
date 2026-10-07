import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deriveTurnsInFlight, readTurnsInFlight } from "./turnsInFlight.js";

function log(...events: Array<Record<string, unknown>>): string {
  return events.map((event) => JSON.stringify({ runId: "r", seq: 1, ...event })).join("\n") + "\n";
}

const started = (agentId: string, turn: number, timestamp = "2026-10-07T11:44:00.000Z") => ({
  type: "agent_turn_started",
  agentId,
  turn,
  timestamp,
});
const ended = (agentId: string, turn: number) => ({ type: "agent_turn_ended", agentId, turn });
const failed = (agentId: string, turn: number) => ({ type: "agent_turn_failed", agentId, turn, error: "boom" });

describe("deriveTurnsInFlight", () => {
  test("an opened turn is in flight, with its turn number and start time", () => {
    expect(deriveTurnsInFlight(log(started("alex", 1, "2026-10-07T11:44:05.000Z")))).toEqual([
      { agentId: "alex", turn: 1, startedAt: "2026-10-07T11:44:05.000Z" },
    ]);
  });

  test("an ended turn is not in flight", () => {
    expect(deriveTurnsInFlight(log(started("alex", 1), ended("alex", 1)))).toEqual([]);
  });

  test("a failed turn is not in flight", () => {
    expect(deriveTurnsInFlight(log(started("alex", 1), failed("alex", 1)))).toEqual([]);
  });

  test("each agent's turns are tracked independently, in file order", () => {
    const turns = deriveTurnsInFlight(
      log(
        started("alex", 1),
        started("bri", 1),
        ended("alex", 1),
        started("cam", 1),
        failed("cam", 1),
        started("alex", 2),
      ),
    );
    expect(turns.map(({ agentId, turn }) => ({ agentId, turn }))).toEqual([
      { agentId: "bri", turn: 1 },
      { agentId: "alex", turn: 2 },
    ]);
  });

  test("a closing event for a different turn leaves the open turn in flight", () => {
    expect(deriveTurnsInFlight(log(started("alex", 3), ended("alex", 2))).map((t) => t.turn)).toEqual([3]);
  });

  test("a turn abandoned by a dead process is replaced by the restarted agent's turn", () => {
    // The restarted process counts from 1 again and closes its own turn.
    expect(deriveTurnsInFlight(log(started("alex", 4), started("alex", 1), ended("alex", 1)))).toEqual([]);
  });

  test("the Moderator's own turns, other events and unparseable lines are ignored", () => {
    const text =
      log(
        { type: "agent_turn_failed", agentId: "moderator", turn: 1, error: "x" },
        { type: "agent_heartbeat", agentId: "alex", state: "active" },
        { type: "message", agentId: "alex", content: "hi" },
      ) + '{"type":"agent_turn_started","agentId":"bri","tu';
    expect(deriveTurnsInFlight(text)).toEqual([]);
  });
});

describe("readTurnsInFlight", () => {
  test("reads the Run's event log", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
    await mkdir(path.join(logDir, "run-1"));
    await writeFile(path.join(logDir, "run-1", "events.jsonl"), log(started("alex", 1)));
    expect((await readTurnsInFlight(logDir, "run-1"))?.map((t) => t.agentId)).toEqual(["alex"]);
  });

  test("a log that does not exist yet holds no turns", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
    expect(await readTurnsInFlight(logDir, "run-1")).toEqual([]);
  });

  test("an unreadable log is unknown, not empty", async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), "agora-test-"));
    // A directory where the file should be makes the read fail with EISDIR.
    await mkdir(path.join(logDir, "run-1", "events.jsonl"), { recursive: true });
    expect(await readTurnsInFlight(logDir, "run-1")).toBeNull();
  });
});
