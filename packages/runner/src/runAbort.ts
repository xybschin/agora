/**
 * How a failed room-setup step aborts a Run, recorded so the transcript ends on
 * a verdict rather than ambiguity.
 *
 * `createRunRoom` refuses a Run in two ways, and both must end the transcript on
 * a `run_aborted` event with a readable reason, else the Run reads as merely
 * "incomplete" with no explanation (ADR-0005):
 *
 * - a `RoomPermissionsError`: the room does not hold the permissions the Run
 *   depends on;
 * - a `ReaderInviteError`: the room is right, but a declared or locally-supplied
 *   Reader could not be invited.
 *
 * This lives outside `index.ts` so it can be tested: a top-level script that
 * calls `main()` on import cannot be, and this is exactly the path a Run that
 * cannot be assembled follows.
 */
import type { RunLifecycle } from "./runLifecycle.js";
import { RoomPermissionsError } from "./roomPermissions.js";
import { ReaderInviteError } from "./runRoom.js";

/**
 * Handles a failure from `createRunRoom` that should abort the Run: prints the
 * readable per-run message and records the terminal `run_aborted` event with that
 * reason as its `reason`, so the transcript ends on a verdict. Tick 0 is the
 * honest value -- the room never got far enough for a tick 1.
 *
 * Returns true when the error was an abort-worthy room-setup failure (and was
 * therefore recorded), false when it was any other error and the caller must
 * rethrow/react as it already would.
 */
export async function recordRoomSetupAbort(
  lifecycle: RunLifecycle,
  runId: string,
  err: unknown,
): Promise<boolean> {
  if (!(err instanceof RoomPermissionsError || err instanceof ReaderInviteError)) {
    return false;
  }
  console.error(`Aborting run ${runId}: ${err.message}`);
  await lifecycle.recordTerminal(runId, {
    type: "run_aborted",
    runId,
    reason: err.message,
    timestamp: new Date().toISOString(),
  });
  return true;
}
