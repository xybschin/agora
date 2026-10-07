import { describe, expect, test } from "bun:test";
import type { SequencedEvent } from "@agora/shared";
import { createModeratorWatch } from "./moderatorWatch.js";

const runId = "watch-run";

function assessment(seq: number, classification: "active" | "stale", rationale: string, timestamp: string): SequencedEvent {
  return { seq, type: "moderator_classification", runId, classification, rationale, timestamp };
}

function heartbeat(seq: number, agentId: string): SequencedEvent {
  return { seq, type: "agent_heartbeat", runId, agentId, state: "waiting", timestamp: "2026-10-07T12:00:00.000Z" };
}

function turnFailed(seq: number, agentId: string, turn: number, error: string, timestamp: string): SequencedEvent {
  return { seq, type: "agent_turn_failed", runId, agentId, turn, error, timestamp };
}

function makeWatch(start = 0) {
  let clock = start;
  const printed: string[] = [];
  const warnings: string[] = [];
  const watch = createModeratorWatch({
    print: (line) => printed.push(line),
    warn: (line) => warnings.push(line),
    now: () => clock,
  });
  return {
    watch,
    printed,
    warnings,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("createModeratorWatch", () => {
  test("prints each Assessment with its time, verdict and rationale", () => {
    const { watch, printed } = makeWatch();

    watch.observe([
      heartbeat(1, "moderator"),
      assessment(2, "active", "new arguments are still arriving", "2026-10-07T12:00:05.000Z"),
      assessment(3, "stale", "the agents repeat themselves", "2026-10-07T12:01:10.000Z"),
    ]);

    expect(printed).toEqual([
      "[12:00:05 UTC] Moderator Assessment: ACTIVE — new arguments are still arriving",
      "[12:01:10 UTC] Moderator Assessment: STALE — the agents repeat themselves",
    ]);
  });

  test("does not reprint Assessments already printed on an earlier poll", () => {
    const { watch, printed } = makeWatch();
    const first = assessment(1, "active", "first", "2026-10-07T12:00:05.000Z");

    watch.observe([first]);
    watch.observe([first]);
    watch.observe([first, assessment(2, "active", "second", "2026-10-07T12:00:35.000Z")]);

    expect(printed).toEqual([
      "[12:00:05 UTC] Moderator Assessment: ACTIVE — first",
      "[12:00:35 UTC] Moderator Assessment: ACTIVE — second",
    ]);
  });

  test("tracks printed lines by position, so a repeated seq is still printed", () => {
    // seq is not unique per Run (agora-6s2.6): two writers can stamp the same one.
    const { watch, printed } = makeWatch();
    const first = assessment(7, "active", "first", "2026-10-07T12:00:05.000Z");

    watch.observe([first]);
    watch.observe([first, assessment(7, "active", "second", "2026-10-07T12:00:35.000Z")]);

    expect(printed).toHaveLength(2);
    expect(printed[1]).toContain("second");
  });

  test("prints each failed turn, an agent's or the Moderator's, with its agent, turn and error", () => {
    const { watch, printed } = makeWatch();

    watch.observe([
      heartbeat(1, "agent-a"),
      turnFailed(2, "agent-a", 1, "429 No capacity available", "2026-10-07T09:37:12.000Z"),
      turnFailed(3, "moderator", 1, "503 Service Unavailable", "2026-10-07T09:37:40.000Z"),
    ]);

    expect(printed).toEqual([
      "[09:37:12 UTC] Turn failed: agent-a turn 1 — 429 No capacity available",
      "[09:37:40 UTC] Turn failed: moderator turn 1 — 503 Service Unavailable",
    ]);
  });

  test("prints each failed turn once across polls, even when two share a seq", () => {
    const { watch, printed } = makeWatch();
    const first = turnFailed(4, "agent-a", 1, "429", "2026-10-07T09:37:12.000Z");

    watch.observe([first]);
    watch.observe([first]);
    watch.observe([first, turnFailed(4, "agent-b", 1, "429", "2026-10-07T09:37:13.000Z")]);

    expect(printed).toEqual([
      "[09:37:12 UTC] Turn failed: agent-a turn 1 — 429",
      "[09:37:13 UTC] Turn failed: agent-b turn 1 — 429",
    ]);
  });

  test("warns once when the Moderator has written nothing for 60s", () => {
    const { watch, warnings, advance } = makeWatch();

    watch.observe([]);
    advance(59_000);
    watch.observe([heartbeat(1, "agent-a")]);
    expect(warnings).toEqual([]);

    advance(1_000);
    watch.observe([heartbeat(1, "agent-a")]);
    advance(500);
    watch.observe([heartbeat(1, "agent-a")]);
    advance(30_000);
    watch.observe([heartbeat(1, "agent-a")]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("60s");
    expect(warnings[0]).toContain("Moderator");
  });

  test("a heartbeat or an Assessment from the Moderator resets the quiet clock", () => {
    const { watch, warnings, advance } = makeWatch();
    const events: SequencedEvent[] = [];

    advance(50_000);
    events.push(heartbeat(1, "moderator"));
    watch.observe(events);
    advance(50_000);
    events.push(assessment(2, "active", "still going", "2026-10-07T12:00:05.000Z"));
    watch.observe(events);
    advance(50_000);
    watch.observe(events);

    expect(warnings).toEqual([]);
  });

  test("warns again for a later gap after the Moderator came back", () => {
    const { watch, warnings, advance } = makeWatch();
    const events: SequencedEvent[] = [];

    advance(60_000);
    watch.observe(events);
    events.push(heartbeat(1, "moderator"));
    watch.observe(events);
    advance(75_000);
    watch.observe(events);

    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("75s");
  });
});
