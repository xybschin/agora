import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgoraEvent } from "./events.js";

/**
 * Appends one JSONL event to logDir/<runId>/events.jsonl.
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
  await appendFile(path.join(dir, "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
}
