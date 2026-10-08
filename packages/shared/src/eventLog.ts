/**
 * The one writer of a Run's event log, `logs/<runId>/events.jsonl`. Every
 * process that records an event (the runner on the host, each agent and the
 * Moderator in their containers) goes through appendEvent, which is what
 * stamps the per-Run `seq` described on SequencedEvent in events.ts.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgoraEvent } from "./events.js";

/**
 * Monotonic sequence counter per Run, keyed by runId. The event-log writer
 * stamps every event with the next `seq` for its runId at write time (rather
 * than trusting callers to supply one), so two different runIds get independent
 * counters and events within a runId read back in append order.
 *
 * The counter is process-local: the runner (host) and each agent and Moderator
 * container write into the same bind-mounted events.jsonl, and each holds its
 * own map starting from 1. So `seq` is monotonic only among one process's
 * events, and events from different processes routinely share a `seq` value;
 * line order in the file is the only cross-process ordering. This is a known,
 * accepted limit: per-writer ordering is enough to reconstruct what happened
 * without coordinating a global counter across containers (see ADR-0008).
 */
const seqByRun: Map<string, number> = new Map();

function nextSeq(runId: string): number {
  const next = (seqByRun.get(runId) ?? 0) + 1;
  seqByRun.set(runId, next);
  return next;
}

/**
 * Appends one JSONL event to logDir/<runId>/events.jsonl, creating the Run's
 * directory if needed and assigning the event's `seq` at write time (any `seq`
 * the caller passes is overwritten).
 * Called from both the runner (host-side, logDir = <repo>/logs) and each
 * agent and Moderator container (logDir = /logs, a bind-mounted shared
 * volume), so a single Run's full event log -- Transcript messages, stances,
 * usage, turn brackets -- lands in one file regardless of which process wrote it.
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
