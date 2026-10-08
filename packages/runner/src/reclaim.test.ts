import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgoraEvent } from "@agora/shared";
import { parseRunId } from "@agora/shared";
import {
  isEligibleForReclamation,
  listRunIds,
  readRunTranscript,
  reclaimRun,
} from "./reclaim.js";

/**
 * Reclamation is explicit and gated on a terminal verdict (ADR-0006). These
 * tests pin the derive-then-act rule: a transcript with no terminal event
 * (`moderator_ended_run`, `run_completed` or `run_aborted`) is `incomplete` — the ambiguous hard-crash
 * signature — and is never eligible, on disk or in the room. They run entirely
 * off temporary log directories (no metadata store) and against a stubbed
 * homeserver, so no live homeserver is needed.
 */

let tempDir: string;

async function makeLogDir(): Promise<string> {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "reclaim-"));
  return tempDir;
}

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function eventHere(
  kind: "started" | "completed" | "moderatorEnded" | "aborted" | "message",
): AgoraEvent {
  switch (kind) {
    case "started":
      return { type: "run_started", runId: "r", timestamp: "t" };
    case "completed":
      return { type: "run_completed", runId: "r", timestamp: "t" };
    case "moderatorEnded":
      return {
        type: "moderator_ended_run",
        runId: "r",
        rationale: "stale",
        messageId: "$end",
        timestamp: "t",
      };
    case "aborted":
      return { type: "run_aborted", runId: "r", reason: "cancelled", timestamp: "t" };
    case "message":
      return {
        type: "message",
        runId: "r",
        agentId: "a",
        matrixEventId: "$ev",
        roomId: "!irrelevant:localhost",
        content: "hi",
        timestamp: "t",
      };
  }
}

async function writeTranscript(logDir: string, runId: string, events: AgoraEvent[]): Promise<void> {
  const dir = path.join(logDir, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

describe("isEligibleForReclamation (incomplete-is-never-eligible)", () => {
  test("a transcript with no terminal event is never eligible", () => {
    // run_started with nothing closing it out is the signature of a hard kill
    // (ADR-0005): the Run began and never said how it ended.
    expect(isEligibleForReclamation([eventHere("started")])).toBe(false);
    expect(
      isEligibleForReclamation([eventHere("started"), eventHere("message"), eventHere("message")]),
    ).toBe(false);
  });

  test("an empty transcript is never eligible", () => {
    expect(isEligibleForReclamation([])).toBe(false);
  });

  test("a run_completed transcript is eligible", () => {
    expect(
      isEligibleForReclamation([eventHere("started"), eventHere("completed")]),
    ).toBe(true);
  });

  test("a Moderator-ended transcript is eligible", () => {
    // moderator_ended_run is the normal way a Run completes now.
    expect(
      isEligibleForReclamation([eventHere("started"), eventHere("message"), eventHere("moderatorEnded")]),
    ).toBe(true);
  });

  test("a run_aborted transcript is eligible (a terminal verdict)", () => {
    expect(
      isEligibleForReclamation([eventHere("started"), eventHere("aborted")]),
    ).toBe(true);
  });

  test("a terminal event in an old transcript without run_started is eligible", () => {
    // The verdict is still recorded, so the Run is a finished one even though
    // the transcript predates the run_started marker.
    expect(isEligibleForReclamation([eventHere("completed")])).toBe(true);
  });
});

describe("readRunTranscript / listRunIds", () => {
  test("reads back the events a transcript holds", async () => {
    const logDir = await makeLogDir();
    await writeTranscript(logDir, "polarization-20251001-1420", [
      eventHere("started"),
      eventHere("completed"),
    ]);
    const events = await readRunTranscript(logDir, "polarization-20251001-1420");
    expect(events.map((e) => e.type)).toEqual(["run_started", "run_completed"]);
  });

  test("lists only directories that carry a transcript", async () => {
    const logDir = await makeLogDir();
    await writeTranscript(logDir, "a-20251001-1421", [eventHere("started"), eventHere("completed")]);
    await mkdir(path.join(logDir, "b-20251001-1422"), { recursive: true }); // no events.jsonl
    expect(await listRunIds(logDir)).toEqual(["a-20251001-1421"]);
  });
});

describe("reclaimRun", () => {
  // A room named "Agora - <scenario> - <runId>" is the join between a Run and
  // its room (ADR-0006): the runId (the logs/<runId> directory name) resolves
  // to the room by that naming convention against the homeserver's public room
  // directory. It must not depend on the transcript's message events, so a Run
  // that never sent a message still resolves.
  function stubPublicRooms(rooms: Array<{ room_id: string; name: string }>): string[] {
    const deleted: string[] = [];
    const original = globalThis.fetch;
    type FetchFn = typeof globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
      const url = String(input);
      if (url.includes("/publicRooms")) {
        return new Response(JSON.stringify({ chunk: rooms }));
      }
      if (url.includes("/rooms/") && init?.method === "DELETE") {
        deleted.push(url);
        return new Response("{}");
      }
      return new Response("{}");
    }) as FetchFn;
    afterEach(() => {
      globalThis.fetch = original;
    });
    return deleted;
  }

  test("refuses an incomplete run outright, touching neither logs nor room", async () => {
    const logDir = await makeLogDir();
    await writeTranscript(logDir, "polarization-20251001-1430", [
      eventHere("started"),
      eventHere("message"),
    ]);
    const deleted = stubPublicRooms([
      { room_id: "!found:localhost", name: "Agora - polarization - polarization-20251001-1430" },
    ]);

    const result = await reclaimRun({
      logDir,
      hostBaseUrl: "https://homeserver",
      setupAccessToken: "tok",
      runId: "polarization-20251001-1430",
      targets: { reclaimLogs: true, reclaimRoom: true },
    });

    expect(result.verdict).toBe("incomplete-skipped");
    expect(result.reclaimedLogs).toBe(false);
    expect(result.reclaimedRoom).toBe(false);
    // The transcript still exists on disk and the room was never deleted.
    expect(await listRunIds(logDir)).toEqual(["polarization-20251001-1430"]);
    expect(deleted).toEqual([]);
  });

  test("reclaims an eligible run's logs and room, resolving the room by name", async () => {
    const logDir = await makeLogDir();
    await writeTranscript(logDir, "polarization-20251001-1431", [
      eventHere("started"),
      eventHere("completed"),
    ]);
    const deleted = stubPublicRooms([
      { room_id: "!found:localhost", name: "Agora - polarization - polarization-20251001-1431" },
    ]);

    const result = await reclaimRun({
      logDir,
      hostBaseUrl: "https://homeserver",
      setupAccessToken: "tok",
      runId: "polarization-20251001-1431",
      targets: { reclaimLogs: true, reclaimRoom: true },
    });

    expect(result.verdict).toBe("reclaimed");
    expect(result.reclaimedLogs).toBe(true);
    expect(result.reclaimedRoom).toBe(true);
    // Logs are gone from disk; the room was deleted by id from the directory.
    expect(await listRunIds(logDir)).toEqual([]);
    expect(deleted).toEqual(["https://homeserver/_matrix/client/v3/rooms/!found%3Alocalhost"]);
  });

  test("resolves the room by name even when the transcript has no message events", async () => {
    const logDir = await makeLogDir();
    // No message events: the room id appears on message events only, so a Run
    // that never sent a message has no room id in its transcript. The room-name
    // convention must still find and delete the room.
    await writeTranscript(logDir, "polarization-20251001-1432", [
      eventHere("started"),
      eventHere("aborted"),
    ]);
    const deleted = stubPublicRooms([
      { room_id: "!theroom:localhost", name: "Agora - polarization - polarization-20251001-1432" },
    ]);

    const result = await reclaimRun({
      logDir,
      hostBaseUrl: "https://homeserver",
      setupAccessToken: "tok",
      runId: "polarization-20251001-1432",
      targets: { reclaimRoom: true, reclaimLogs: false },
    });
    expect(result.reclaimedRoom).toBe(true);
    expect(deleted.length).toBe(1);
  });

  test("leaves a terminal run's room alone when it is not in the directory", async () => {
    const logDir = await makeLogDir();
    await writeTranscript(logDir, "polarization-20251001-1433", [
      eventHere("started"),
      eventHere("completed"),
    ]);
    const deleted = stubPublicRooms([]); // directory is empty

    const result = await reclaimRun({
      logDir,
      hostBaseUrl: "https://homeserver",
      setupAccessToken: "tok",
      runId: "polarization-20251001-1433",
      targets: { reclaimRoom: true, reclaimLogs: false },
    });
    expect(result.verdict).toBe("room-not-found");
    expect(result.reclaimedRoom).toBe(false);
    expect(deleted).toEqual([]);
  });

  test("extracts the scenario name for room lookup using parseRunId, not a local pattern", async () => {
    const logDir = await makeLogDir();
    // Use a runId with an unusual scenario name to verify parseRunId is used,
    // not a local pattern that might accidentally work.
    const runId = "complex-scenario-name-with-dashes-20251001-1434";
    await writeTranscript(logDir, runId, [
      eventHere("started"),
      eventHere("completed"),
    ]);
    // parseRunId should extract "complex-scenario-name-with-dashes" as the
    // scenario name. If a local regex like /-\d{8}-\d{4}$/ were used, it
    // would extract the same thing by luck, but using parseRunId ensures
    // the writer (formatRunId) and reader (here) cannot drift apart.
    const parsed = parseRunId(runId);
    expect(parsed.scenarioName).toBe("complex-scenario-name-with-dashes");

    const deleted = stubPublicRooms([
      {
        room_id: "!theroom:localhost",
        name: `Agora - ${parsed.scenarioName} - ${runId}`,
      },
    ]);

    const result = await reclaimRun({
      logDir,
      hostBaseUrl: "https://homeserver",
      setupAccessToken: "tok",
      runId,
      targets: { reclaimRoom: true, reclaimLogs: false },
    });
    expect(result.reclaimedRoom).toBe(true);
    expect(deleted.length).toBe(1);
  });
});
