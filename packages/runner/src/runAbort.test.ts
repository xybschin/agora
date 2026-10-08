// Pins which room-setup failures recordRoomSetupAbort turns into a terminal
// run_aborted (RoomPermissionsError, ReaderInviteError) and that it leaves every
// other error unrecorded for the caller.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRunLifecycle } from "./runLifecycle.js";
import { recordRoomSetupAbort } from "./runAbort.js";
import { RoomPermissionsError } from "./roomPermissions.js";
import { ReaderInviteError } from "./runRoom.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agora-rabort-"));
  dirs.push(dir);
  return dir;
}

function readEvents(logDir: string, runId: string): Record<string, unknown>[] {
  return readFileSync(join(logDir, runId, "events.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// The one acceptably-messy bit of stubbing: the lifecycle's only dependency is a
// composeDown that a room-setup abort never reaches (containers were never up).
function lifecycle(logDir: string) {
  return createRunLifecycle({
    logDir,
    composeDown: async () => {},
  });
}

describe("recordRoomSetupAbort", () => {
  test("records a ReaderInviteError as a run_aborted that names the Reader", async () => {
    // The heart of agora-7bw: a Reader who cannot be invited still aborts the
    // Run (fatal), but the transcript must end on run_aborted with a reason that
    // says which Reader and why -- not on ambiguous incompleteness.
    const logDir = freshLogDir();
    const life = lifecycle(logDir);
    await life.begin("r1");

    const handled = await recordRoomSetupAbort(
      life,
      "r1",
      new ReaderInviteError(
        "@missing:localhost",
        "POST .../invite -> HTTP 403: unknown user",
      ),
    );

    expect(handled).toBe(true);
    const aborted = readEvents(logDir, "r1").find((e) => e.type === "run_aborted");
    expect(aborted).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        runId: "r1",
        reason: 'could not invite Reader "@missing:localhost" into the run\'s room: POST .../invite -> HTTP 403: unknown user',
      }),
    );
  });

  test("records a RoomPermissionsError exactly as before", async () => {
    const logDir = freshLogDir();
    const life = lifecycle(logDir);
    await life.begin("r1");

    const handled = await recordRoomSetupAbort(
      life,
      "r1",
      new RoomPermissionsError("room X does not hold the permissions this Run asked for"),
    );

    expect(handled).toBe(true);
    const aborted = readEvents(logDir, "r1").find((e) => e.type === "run_aborted");
    expect(aborted).toEqual(
      expect.objectContaining({
        type: "run_aborted",
        reason: "room X does not hold the permissions this Run asked for",
      }),
    );
  });

  test("leaves any other error alone, so the caller rethrows it as before", async () => {
    const logDir = freshLogDir();
    const life = lifecycle(logDir);
    await life.begin("r1");

    const handled = await recordRoomSetupAbort(
      life,
      "r1",
      new Error("POST .../createRoom -> HTTP 500: boom"),
    );

    expect(handled).toBe(false);
    expect(readEvents(logDir, "r1").some((e) => e.type === "run_aborted")).toBe(false);
  });
});
