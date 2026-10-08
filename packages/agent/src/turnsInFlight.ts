/**
 * Which agents are mid-turn right now, read off a Run's event log. The
 * Moderator (moderator.ts) has no other view of agent turns, and uses this to
 * tell its model when a quiet room may only mean replies are still being
 * composed.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** An agent whose latest turn has opened but not yet closed. */
export interface TurnInFlight {
  agentId: string;
  turn: number;
  /** The `agent_turn_started` timestamp, as written (ISO 8601). */
  startedAt: string;
}

/**
 * Derives which agents currently have a turn open from a Run's event log
 * (`events.jsonl` contents): an `agent_turn_started` not yet closed by an
 * `agent_turn_ended` or `agent_turn_failed` for the same agent and turn.
 *
 * Lines are read in file order, never by `seq` (which is not unique across the
 * processes writing one log). Only an agent's latest start counts: a process
 * that died mid-turn and restarted opens a fresh turn, and the abandoned one
 * must not be reported alongside it. The Moderator's own turns are left out,
 * as are lines that do not parse (e.g. one being appended right now).
 */
export function deriveTurnsInFlight(eventsJsonl: string): TurnInFlight[] {
  const open = new Map<string, TurnInFlight>();
  for (const line of eventsJsonl.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: { type?: unknown; agentId?: unknown; turn?: unknown; timestamp?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const { type, agentId, turn, timestamp } = event;
    if (typeof agentId !== "string" || agentId === "moderator" || typeof turn !== "number") continue;
    if (type === "agent_turn_started") {
      open.set(agentId, { agentId, turn, startedAt: typeof timestamp === "string" ? timestamp : "" });
    } else if (type === "agent_turn_ended" || type === "agent_turn_failed") {
      if (open.get(agentId)?.turn === turn) open.delete(agentId);
    }
  }
  return [...open.values()];
}

/**
 * Reads the Run's event log and derives the turns in flight. A log that does
 * not exist yet holds no turns; any other read failure yields null, so the
 * caller can say it does not know rather than claim nobody is mid-turn.
 */
export async function readTurnsInFlight(logDir: string, runId: string): Promise<TurnInFlight[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(logDir, runId, "events.jsonl"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    return null;
  }
  return deriveTurnsInFlight(text);
}
