// Pins the runId format (formatRunId/parseRunId must round-trip, since reclaim
// recovers a Run's Scenario from its runId) and how deriveRunStatus reads a Run
// status off an event log, including the legacy tick-count fallback.

import { describe, expect, test } from "bun:test";
import { deriveRunStatus, formatRunId, parseRunId } from "./runAnalysis.js";
import type { AgoraEvent } from "./events.js";

describe("formatRunId", () => {
  test("renders a sanitized scenario name and a readable UTC YYYYMMDD-HHMM stamp", () => {
    expect(formatRunId("Remote Work Policy", new Date("2025-10-01T14:20:33Z"))).toBe(
      "remote-work-policy-20251001-1420",
    );
  });

  test("keeps the timestamp minutes-only in UTC", () => {
    // 14:20:33 still reads as 1420; seconds are deliberately dropped.
    expect(formatRunId("polarization", new Date("2025-10-01T14:20:59Z"))).toBe(
      "polarization-20251001-1420",
    );
  });
});

describe("parseRunId", () => {
  test("splits a kebab-case scenario name from its YYYYMMDD-HHMM stamp suffix", () => {
    expect(parseRunId("remote-work-policy-20251001-1420")).toEqual({
      scenarioName: "remote-work-policy",
      timestamp: "20251001-1420",
    });
  });

  test("handles a single-word scenario name", () => {
    expect(parseRunId("polarization-20251001-1420")).toEqual({
      scenarioName: "polarization",
      timestamp: "20251001-1420",
    });
  });

  test("rejects a runId that is not the YYYYMMDD-HHMM convention", () => {
    // The old epoch-millis suffix must no longer parse: runIds now carry a
    // readable UTC stamp, not a bare digit string.
    expect(() => parseRunId("remote-work-policy-1789569350032")).toThrow();
  });
});

describe("formatRunId / parseRunId round-trip", () => {
  // The minute-only UTC stamp a given ISO instant renders to: slice to the
  // minute then strip the punctuation, matching formatRunId's own derivation.
  const stampOf = (iso: string) =>
    new Date(iso).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");

  test("parseRunId reverses formatRunId, recovering scenario and the readable stamp", () => {
    const scenario = "polarization";
    for (const iso of [
      "2025-01-01T00:00:00Z",
      "2025-10-01T14:20:33Z",
      "2026-12-31T23:59:59Z",
    ]) {
      const runId = formatRunId(scenario, new Date(iso));
      expect(parseRunId(runId)).toEqual({
        scenarioName: scenario,
        timestamp: stampOf(iso),
      });
    }
  });

  test("the stamp is lexicographically sortable in chronological order", () => {
    const ids = [
      formatRunId("s", new Date("2025-01-01T00:00:00Z")),
      formatRunId("s", new Date("2025-10-01T14:20:33Z")),
      formatRunId("s", new Date("2026-12-31T23:59:59Z")),
    ].sort();
    expect(ids.map((id) => parseRunId(id).timestamp)).toEqual([
      "20250101-0000",
      "20251001-1420",
      "20261231-2359",
    ]);
  });
});

// A Run status is recorded, not inferred: the runner writes exactly one
// terminal event per Run (packages/runner/src/runLifecycle.ts). "run_started"
// marks an event log as belonging to the new vocabulary. Per turn, agents
// append "stance"/"usage"/"message" plus "agent_turn_started"/"agent_turn_ended"
// brackets (packages/agent/src/loop.ts). deriveRunStatus returns only a status;
// ordering is carried by the per-event `seq` stamped at write time.
function stance(): AgoraEvent {
  return { type: "stance", runId: "r", agentId: "a", stance: 0, timestamp: "t" };
}

function started(): AgoraEvent {
  return { type: "run_started", runId: "r", timestamp: "t" };
}

function completed(): AgoraEvent {
  return { type: "run_completed", runId: "r", timestamp: "t" };
}

function moderatorEnded(): AgoraEvent {
  return { type: "moderator_ended_run", runId: "r", rationale: "stale", messageId: "$end", timestamp: "t" };
}

function aborted(reason: string): AgoraEvent {
  return { type: "run_aborted", runId: "r", reason, timestamp: "t" };
}

// A legacy transcript (predating the tick->seq change) still carries `tick` on
// its events. Only the legacy fallback in deriveRunStatus reads it.
type LegacyEvent = AgoraEvent & { tick: number };
const legacyStance = (tick: number): LegacyEvent => ({ ...stance(), tick });

describe("deriveRunStatus", () => {
  test("is aborted when a run_aborted event is present, even if it reached the final tick", () => {
    const events = [started(), stance(), stance(), aborted("budget exceeded")];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "aborted" });
  });

  test("is aborted when a run_aborted event is present, even alongside run_completed", () => {
    // A transcript carrying both terminal events is malformed. Aborting is the
    // safe reading: an operator must never be told a Run finished cleanly when
    // the same file also says it was stopped.
    const events = [started(), stance(), completed(), aborted("cancelled by SIGTERM")];
    expect(deriveRunStatus(events, 1)).toEqual({ status: "aborted" });
  });

  test("is aborted when a run_aborted event is present, even alongside moderator_ended_run", () => {
    const events = [started(), stance(), moderatorEnded(), aborted("wall-clock timeout")];
    expect(deriveRunStatus(events, 1)).toEqual({ status: "aborted" });
  });

  test("is completed when the Moderator ended the Run", () => {
    // moderator_ended_run is how a Run normally ends now; nothing writes
    // run_completed any more.
    const events = [started(), stance(), moderatorEnded()];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "completed" });
  });

  test("is completed when a run_completed event is present", () => {
    const events = [started(), stance(), stance(), completed()];
    expect(deriveRunStatus(events, 2)).toEqual({ status: "completed" });
  });

  test("is NOT completed just because tick events reached the final tick", () => {
    // The false all-clear this replaces: a Run whose last tick's events landed
    // but which never recorded its own completion (crash between the final
    // tick and the bookkeeping) used to read as completed.
    const events = [started(), stance(), stance(), stance()];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "incomplete" });
  });

  test("is incomplete when a started Run recorded no terminal event", () => {
    // The signature of a killed Run: run_started is present, nothing closes
    // it out. That is what distinguishes "began and never finished" from an
    // empty or foreign directory.
    const events = [started(), stance()];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "incomplete" });
  });

  test("is incomplete for a Run that only recorded run_started", () => {
    expect(deriveRunStatus([started()], 3)).toEqual({ status: "incomplete" });
  });

  test("falls back to the tick-count inference for transcripts with no run_started", () => {
    // Backward compatibility: Runs recorded before run_started/run_completed
    // existed carry neither, and must not all regress to "incomplete" the day
    // this vocabulary ships. They are the only transcripts still carrying a
    // `tick` field, which the fallback reads.
    const events = [legacyStance(1), legacyStance(2), legacyStance(3)];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "completed" });
  });

  test("a legacy transcript below the final tick is not inferred completed", () => {
    // No run_started, so this exercises the tick-count fallback, not the
    // modern no-terminal-event path.
    const events = [legacyStance(1), legacyStance(2)];
    expect(deriveRunStatus(events, 3)).toEqual({ status: "incomplete" });
  });

  test("ignores the Moderator's tool-call log", () => {
    const toolCall: AgoraEvent = {
      type: "moderator_tool_call",
      runId: "r",
      tool: "matrix_read_room",
      args: { limit: 100 },
      resultSummary: "3 messages",
      timestamp: "t",
    };
    expect(deriveRunStatus([started(), toolCall], 1)).toEqual({ status: "incomplete" });
    expect(deriveRunStatus([started(), toolCall, completed()], 1)).toEqual({ status: "completed" });
  });

  test("is incomplete for an empty event list", () => {
    expect(deriveRunStatus([], 3)).toEqual({ status: "incomplete" });
  });
});
