/**
 * The permissions a Run's room is pinned to, and the read-back that proves the
 * homeserver stored them.
 *
 * A Reader has to be able to read a Run's whole conversation and yet be
 * structurally unable to speak: one stray message from a human would land in the
 * Transcript and draw agent replies, contaminating the very phenomenon the Run
 * exists to observe (ADR-0003). Left at the `createRoom` preset's defaults, every
 * member of a `public_chat` room can post, so the permissions are written
 * explicitly instead of inherited.
 *
 * They are written as an explicit `m.room.power_levels` state event *after* the
 * room exists, rather than as `initial_state` on `createRoom`, because how a
 * caller-supplied power_levels event merges with the creator's implicit level
 * 100 is homeserver-specific and this repo pins no Synapse version (ADR-0003,
 * rejected options).
 *
 * Like the rest of the Matrix access here, this talks to the Client-Server API
 * with raw fetch, the shared `csRequest` seam and the shared `roomPath` path
 * builder, rather than matrix-js-sdk.
 */

import { roomPath, csRequest } from "./matrixRooms.js";

/**
 * The subset of `m.room.power_levels` this harness cares about. A homeserver is
 * free to store more than this; the read-back below compares only these keys,
 * precisely because of that.
 */
export interface RoomPowerLevels {
  users: Record<string, number>;
  users_default: number;
  events: Record<string, number>;
  events_default: number;
  state_default: number;
  invite: number;
  kick: number;
  ban: number;
  redact: number;
}

/**
 * The agents. High enough to clear `events_default` so an agent can post a
 * message and a reaction, low enough that everything above them — every value
 * set to `SETUP_LEVEL` — is out of reach.
 */
const AGENT_LEVEL = 50;

/**
 * The level everything that decides who else is in the room or what the room is
 * sits at: above `AGENT_LEVEL`, so no agent can reach any of it.
 *
 * It is not named for the setup account in `users`: Synapse (the only
 * homeserver this repo runs) refuses a power-levels event whose `users` names
 * the room's creator — "Creator user ... must not appear in content.users" —
 * because the creator's level is 100 by the creator rule, immutable, and not an
 * entry in the event. The setup account *is* the room's creator (it calls
 * `createRoom`), so its 100 is that implicit, homeserver-guaranteed value, not
 * a `users` entry this harness writes or reads back. See the note in
 * `runRoomPowerLevels`.
 */
const SETUP_LEVEL = 100;

/**
 * A Reader's level. It is the default rather than an entry in `users`, which is
 * what makes it structural: nothing on the invite path can name a Reader, so no
 * Reader can ever be seated above `events_default`.
 */
const READER_LEVEL = 0;

/**
 * The power levels a Run's room is written with, and the single source of truth
 * for what an agent and a Reader can each do in it.
 *
 * The shape is a two-step ladder: the agents sit above the room's default event
 * threshold so they can speak, and everything that decides *who else is in the
 * room* or *what the room is* sits above the agents, which leaves a Reader at
 * the bottom with no way up.
 *
 * The setup account — which owns the room as its creator — is deliberately *not*
 * an entry in `users`. Synapse refuses a power-levels event whose `users` names
 * the creator, because a creator's level 100 is granted by the creator rule and
 * cannot be changed or re-stated (a live Run died on exactly that 400). So the
 * room's owner sits at 100 implicitly, not because this event says so, and the
 * read-back that proves what the room holds can only confirm the entries this
 * harness writes — the agents — plus the thresholds. That a homeserver could
 * silently keep an owner below the levels is closed off by the creator rule
 * itself, which is why the owner's 100 needs no entry here.
 */
export function runRoomPowerLevels(params: {
  agentUserIds: readonly string[];
}): RoomPowerLevels {
  const { agentUserIds } = params;

  // `users` names every agent explicitly. The setup account is the creator and
  // so is already at 100 by the creator rule, which is exactly why it must not
  // also appear here — see the note above.
  const users: Record<string, number> = {};
  for (const userId of agentUserIds) {
    users[userId] = AGENT_LEVEL;
  }

  return {
    users,
    // A Reader is nobody in this map, so it lands here: read everything the
    // room holds, send nothing at all.
    users_default: READER_LEVEL,
    events: {
      // The escalation path, named explicitly rather than left to
      // `state_default`: an agent must not be able to rewrite this event and
      // hand itself 100.
      "m.room.power_levels": SETUP_LEVEL,
      // The room's metadata: its name, topic, avatar and alias, plus the events
      // that decide who can read the room at all. Agents get none of them.
      "m.room.name": SETUP_LEVEL,
      "m.room.topic": SETUP_LEVEL,
      "m.room.avatar": SETUP_LEVEL,
      "m.room.canonical_alias": SETUP_LEVEL,
      "m.room.history_visibility": SETUP_LEVEL,
      "m.room.encryption": SETUP_LEVEL,
      "m.room.tombstone": SETUP_LEVEL,
      "m.room.server_acl": SETUP_LEVEL,
    },
    // `m.room.message` and `m.reaction` are named nowhere above, so both fall to
    // this threshold: an agent at `AGENT_LEVEL` clears it and speaks, a Reader at
    // `READER_LEVEL` does not and is refused both. That is the whole of the
    // Reader guarantee, in one number.
    events_default: AGENT_LEVEL,
    // The backstop behind the named events: any state event this harness did not
    // think to list is still above the agents.
    state_default: SETUP_LEVEL,
    // Who else may be in the room. All three were open to an agent at the
    // preset's levels, so an agent could have pulled a Reader -- or another
    // account -- into the room it is being watched in.
    invite: SETUP_LEVEL,
    kick: SETUP_LEVEL,
    ban: SETUP_LEVEL,
    // Redaction is the same privilege wearing a different hat: an agent able to
    // redact could delete a Reader's message or an agent's, rewriting the
    // Transcript the Run produced.
    redact: SETUP_LEVEL,
  };
}

/** The levels that are single numbers and so have to match exactly. */
const SCALAR_KEYS = [
  "users_default",
  "events_default",
  "state_default",
  "invite",
  "kick",
  "ban",
  "redact",
] as const satisfies readonly (keyof RoomPowerLevels)[];

/** The levels that are maps of user id / event type to a number. */
const MAP_KEYS = ["users", "events"] as const satisfies readonly (keyof RoomPowerLevels)[];

/**
 * Reports every way the stored `m.room.power_levels` event fails to hold what
 * the Run asked for, as human-readable differences. An empty list means the
 * homeserver stored the permissions the Run depends on.
 *
 * Only the keys this harness *set* are compared, and only the entries it set
 * inside the maps. That is deliberate on two counts: a homeserver is entitled to
 * add defaults it was never told about (`notifications`, and its own preferred
 * `ban`/`kick` fallbacks), so demanding a key-for-key match would abort Runs over
 * a house style; and a stored `users` map may legitimately hold accounts this
 * Run never wrote -- which is exactly why the check asks "is every level I asked
 * for actually in force", not "is there anything in there I did not expect". The
 * escalation that would make the second question matter -- someone seated above
 * an agent -- is closed off by `m.room.power_levels` and `state_default` both
 * sitting at `SETUP_LEVEL`, so no agent can write the event that would do it.
 */
export function roomPermissionMismatches(
  wanted: RoomPowerLevels,
  stored: unknown,
): string[] {
  if (typeof stored !== "object" || stored === null) {
    return [
      `stored m.room.power_levels is ${JSON.stringify(stored)}, not an object`,
    ];
  }

  const content = stored as Record<string, unknown>;
  const mismatches: string[] = [];

  for (const key of SCALAR_KEYS) {
    if (content[key] !== wanted[key]) {
      mismatches.push(
        `${key}: asked for ${wanted[key]}, homeserver stored ${JSON.stringify(content[key])}`,
      );
    }
  }

  for (const key of MAP_KEYS) {
    const storedMap = content[key];
    if (typeof storedMap !== "object" || storedMap === null) {
      mismatches.push(
        `${key}: asked for a map of levels, homeserver stored ${JSON.stringify(storedMap)}`,
      );
      continue;
    }
    const levels = storedMap as Record<string, unknown>;
    for (const [id, level] of Object.entries(wanted[key])) {
      if (levels[id] !== level) {
        mismatches.push(
          `${key}.${id}: asked for ${level}, homeserver stored ${JSON.stringify(levels[id])}`,
        );
      }
    }
  }

  return mismatches;
}

/**
 * Thrown when a Run's room does not hold the permissions it was built for.
 *
 * Its own type because the two failures the caller has to tell apart are not the
 * same thing: a homeserver error means the Run could not be assembled, while
 * this means it was assembled wrong, and only the second has to be recorded in
 * the Run's Transcript -- as an aborted Run, since that is where Run status
 * comes from.
 */
export class RoomPermissionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomPermissionsError";
  }
}

/**
 * Writes the Run's power levels, then reads them back and refuses the Run if
 * what came back is not what went out.
 *
 * The read-back is the point: `PUT` returning 200 only says the homeserver
 * accepted the event, not that the room ended up with the permissions the Run
 * depends on. A homeserver is free to normalise, merge or reject parts of a
 * power levels event, and a Run whose room has silently kept its preset defaults
 * would put a Reader in a room where they can post. Throwing here means the
 * caller aborts before a human is admitted or an agent is started.
 */
export async function establishRunRoomPermissions(params: {
  baseUrl: string;
  /** The setup account's token: it owns the room and is the only one able to write this. */
  accessToken: string;
  /** The room's id as `createRoom` returned it; `roomPath` is what escapes it. */
  roomId: string;
  powerLevels: RoomPowerLevels;
}): Promise<void> {
  const { baseUrl, accessToken, roomId, powerLevels } = params;
  // One state event, written and read at two spellings of its URL. Power levels
  // live at the empty state key: the PUT names that key explicitly with a
  // trailing slash, and the GET leaves it off, which Synapse treats as the same
  // empty key. The GET answers with the event's content on its own, not wrapped
  // in an envelope, so the read-back compares that body directly. (Reading
  // `.content` off it once aborted every live Run while stubbed tests passed;
  // runRoom.test.ts pins the bare shape.)
  const statePath = roomPath(roomId, "state/m.room.power_levels");

  await csRequest(baseUrl, "PUT", `${statePath}/`, {
    accessToken,
    body: powerLevels,
  });

  const readBack = await csRequest<unknown>(baseUrl, "GET", statePath, {
    accessToken,
  });

  const mismatches = roomPermissionMismatches(powerLevels, readBack);
  if (mismatches.length > 0) {
    throw new RoomPermissionsError(
      `room ${roomId} does not hold the permissions this Run asked for: ${mismatches.join("; ")}`,
    );
  }
}
