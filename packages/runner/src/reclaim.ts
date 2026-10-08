#!/usr/bin/env node
/**
 * Explicit, operator-invoked reclamation of a finished Run's artefacts.
 *
 * Every Run leaves two things behind that the harness never reclaims: the
 * transcript under `logs/<runId>/` on disk, and the Run's Matrix room on the
 * homeserver. The room is the irreplaceable one — it is the only place the
 * group dynamics actually happened — and deleting it destroys the conversation
 * permanently. So the default posture is KEEP FOREVER, deliberately, and this
 * command is the explicit opt-in path to reclaim a specific, finished Run's
 * room and/or logs when an operator decides to.
 *
 * Two properties make the deletion safe:
 *
 * - It is never automatic. This is a separate entrypoint from the normal run
 *   path (`packages/runner/src/index.ts`), so a Run can never trigger it, and
 *   it does nothing unless an operator names a run and a target (--logs and/or
 *   --room). Nothing is auto-expired; there is no retention window.
 * - It is gated on the Run's verdict being terminal. A Run whose transcript
 *   carries no terminal event (`run_completed` or `run_aborted`) is
 *   `incomplete` — under ADR-0005 that is exactly the ambiguous hard-crash
 *   signature — and is never eligible for reclamation. Only a Run that recorded
 *   how it ended may be reclaimed.
 *
 * The mechanism reads the logs (the transcripts) rather than introducing a
 * metadata store, honouring ADR-0001's rejection of a Run-metadata index: status
 * is derived from `logs/<runId>/events.jsonl`, never stored. Derive-then-act,
 * logs as source of truth.
 *
 * Usage:
 *   bun run packages/runner/src/reclaim.ts <runId>... [--logs] [--room]
 *       [--credentials <credentials.yaml>]
 *
 * At least one target flag is required. Without one the command does nothing.
 * A runId names a `logs/<runId>` directory. Only runs whose verdict is terminal
 * are acted on; an `incomplete` run is refused.
 */

import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgoraEvent, SequencedEvent } from "@agora/shared";
import { createLogger, parseRunId } from "@agora/shared";
import { loadCredentials } from "./loadConfig.js";
import { deleteRoom, findRoomIdByName } from "./matrixRooms.js";
import { roomNameForRun } from "./runRoom.js";

const log = createLogger("reclaim");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const LOG_DIR = path.join(REPO_ROOT, "logs");

/**
 * Whether a Run's transcript records a verdict terminal enough to reclaim.
 *
 * Eligibility is gated on the presence of a terminal event (`run_completed` or
 * `run_aborted`), not on `deriveRunStatus`'s verdict. The two agree for every
 * modern transcript — `deriveRunStatus` only reports `completed`/`aborted`
 * when a terminal event is present — but the fallback it carries for transcripts
 * written before `run_started` existed can *guess* completion from the tick
 * count, and guessing must never authorize a destructive delete. A Run that
 * never recorded how it ended (`incomplete`) is the ambiguous hard-crash
 * signature and is never eligible.
 */
export function isEligibleForReclamation(events: readonly AgoraEvent[]): boolean {
  return events.some(
    (event) => event.type === "run_completed" || event.type === "run_aborted",
  );
}

/** Reads one Run's transcript (`logs/<runId>/events.jsonl`) as events. */
export async function readRunTranscript(
  logDir: string,
  runId: string,
): Promise<SequencedEvent[]> {
  const text = await readFile(path.join(logDir, runId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SequencedEvent);
}

/** Lists the runIds that have an on-disk transcript (`logs/<runId>/events.jsonl`). */
export async function listRunIds(logDir: string): Promise<string[]> {
  const entries = await readdir(logDir, { withFileTypes: true });
  const runs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(path.join(logDir, entry.name, "events.jsonl"));
      runs.push(entry.name);
    } catch {
      // A directory without a transcript is not a Run; skip it.
    }
  }
  return runs.sort();
}

export interface ReclaimSelection {
  /** One or more runIds (logs/<runId> directory names), or all eligible ones. */
  runIds: string[] | "all";
}

export interface ReclaimTargets {
  reclaimLogs: boolean;
  reclaimRoom: boolean;
}

export interface ReclaimResult {
  runId: string;
  verdict: "reclaimed" | "incomplete-skipped" | "room-not-found";
  reclaimedLogs: boolean;
  reclaimedRoom: boolean;
}

/**
 * Applies an explicit reclamation to one Run. Never deletes anything the Run
 * did not record ending: an `incomplete` transcript is refused outright.
 *
 * - Logs are reclaimed as a filesystem removal of `logDir/<runId>`.
 * - A room is resolved from the runId by the room-name convention
 *   (`roomNameForRun`, "Agora - <scenario> - <runId>") against the homeserver
 *   using the setup account's token — never from the transcript's `message`
 *   events, which record the room id only when a message was sent.
 */
export async function reclaimRun(params: {
  logDir: string;
  hostBaseUrl: string;
  setupAccessToken: string;
  runId: string;
  targets: ReclaimTargets;
}): Promise<ReclaimResult> {
  const { logDir, hostBaseUrl, setupAccessToken, runId, targets } = params;
  const events = await readRunTranscript(logDir, runId);
  if (!isEligibleForReclamation(events)) {
    return { runId, verdict: "incomplete-skipped", reclaimedLogs: false, reclaimedRoom: false };
  }

  let reclaimedLogs = false;
  if (targets.reclaimLogs) {
    await rm(path.join(logDir, runId), { recursive: true, force: true });
    reclaimedLogs = true;
  }

  let reclaimedRoom = false;
  // The scenario name is recovered from the runId using `parseRunId`, the
  // single place that encodes the runId format (ADR-0003), so the writer
  // (formatRunId) and reader (here) can never drift apart.
  const { scenarioName } = parseRunId(runId);
  const roomName = roomNameForRun(scenarioName, runId);
  const roomId = await findRoomIdByName(hostBaseUrl, setupAccessToken, roomName);
  if (roomId === null) {
    return {
      runId,
      verdict: reclaimedLogs ? "reclaimed" : "room-not-found",
      reclaimedLogs,
      reclaimedRoom: false,
    };
  }
  if (targets.reclaimRoom) {
    await deleteRoom(hostBaseUrl, setupAccessToken, roomId);
    reclaimedRoom = true;
  }

  return { runId, verdict: "reclaimed", reclaimedLogs, reclaimedRoom };
}

function printUsage(): void {
  console.error(
    [
      "Usage: bun run packages/runner/src/reclaim.ts <runId>... [--logs] [--room]",
      "                 [--all-eligible] [--credentials <credentials.yaml>]",
      "",
      "Explicitly reclaims a finished Run's artefacts. Does nothing unless a target",
      "(--logs and/or --room) is named, and never touches a Run whose transcript",
      "has no terminal event (incomplete).",
      "",
      "  <runId>       a logs/<runId> directory name",
      "  --all-eligible  select every terminal (completed/aborted) Run on disk",
      "  --logs        remove logs/<runId> off disk",
      "  --room        delete the Run's Matrix room (resolved by its room name)",
    ].join("\n"),
  );
}

export async function main(args: string[]): Promise<void> {
  const credFlagIndex = args.indexOf("--credentials");
  const credentialsPath =
    credFlagIndex !== -1 && args[credFlagIndex + 1]
      ? args[credFlagIndex + 1]!
      : path.join(REPO_ROOT, "credentials.yaml");

  const selectAll = args.includes("--all-eligible");
  const reclaimLogs = args.includes("--logs");
  const reclaimRoom = args.includes("--room");

  // Does nothing by default: with no target named, there is nothing to do.
  if (!reclaimLogs && !reclaimRoom) {
    printUsage();
    log.error("Nothing to reclaim: pass at least one of --logs or --room.");
    process.exitCode = 1;
    return;
  }

  const runIds: string[] = selectAll
    ? await listRunIds(LOG_DIR)
    : args.filter((arg) => !arg.startsWith("--"));

  if (runIds.length === 0) {
    log.error("Nothing to reclaim: no runIds selected.");
    process.exitCode = 1;
    return;
  }

  const credentials = await loadCredentials(credentialsPath);
  const { hostBaseUrl } = credentials.matrix;
  const setupAccessToken = credentials.matrixSetupAccessToken;

  for (const runId of runIds) {
    try {
      const result = await reclaimRun({
        logDir: LOG_DIR,
        hostBaseUrl,
        setupAccessToken,
        runId,
        targets: { reclaimLogs, reclaimRoom },
      });
      if (result.verdict === "incomplete-skipped") {
        log.warn(`${runId}: incomplete (no terminal event) — never eligible, skipped.`);
      } else {
        const parts: string[] = [];
        if (result.reclaimedLogs) parts.push("logs");
        if (result.reclaimedRoom) parts.push("room");
        if (parts.length > 0) {
          log.info(`${runId}: reclaimed ${parts.join(" and ")}.`);
        } else {
          log.warn(`${runId}: terminal, but nothing reclaimed (room not found).`);
        }
      }
    } catch (err) {
      log.error(`${runId}: failed to reclaim — ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}
