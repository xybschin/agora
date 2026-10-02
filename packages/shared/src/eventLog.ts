import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgoraEvent } from "./events.js";

/**
 * Monotonic sequence counter per Run, keyed by runId. The event-log writer
 * stamps every event with the next `seq` for its runId at write time (rather
 * than trusting callers to supply one), so two different runIds get independent
 * counters and events within a runId read back in append order.
 *
 * The counter is process-local: the runner (host) and each agent container
 * write into the same bind-mounted events.jsonl, and each holds its own map.
 * Two processes writing concurrently may therefore assign the same `seq` to two
 * events — a known, accepted limit, because `seq` restores enough ordering to
 * reconstruct what happened without requiring perfect global ordering across
 * every concurrently-writing container (see the always-active ADR).
 */
const seqByRun: Map<string, number> = new Map();

function nextSeq(runId: string): number {
  const next = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, next);
  return next;
}

/**
 * Appends one JSONL event to logDir/<runId>/events.jsonl, assigning its `seq`
 * at write time.
 * Called from both the runner (host-side, logDir = <repo>/logs) and each
 * agent container (logDir = /logs, a bind-mounted shared volume), so a
 * single run's transcript+stance history lands in one file regardless of
 * which process wrote it.
 */
export async function appendEvent(
  logDir: string,
  runId: string,
  event: AgoraEvent,
): Promise<void> {
  const dir = path.join(logDir, runId);
  await mkdir(dir, { recursive: true });
  const sequenced = { ...event, seq: nextSeq(runId) };
  await appendFile(path.join(dir, "events.jsonl"), JSON.stringify(sequenced) + "\n", "utf8");
}
