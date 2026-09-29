---
status: accepted
---

# One room per Run, with read-only Readers

A Run used to execute against a single room created once by
`matrixBootstrap.ts` and reused by every subsequent Run of that Scenario, so
the agents in a later Run would read the earlier Runs' conversation before
posting anything — even though `docs/CONTEXT.md` claimed each Run yields an
independent conversation. Room creation therefore moved into the runner, and
`matrixBootstrap.ts` now only registers the setup account and one account per
agent. Alongside this, each Run's room admits its Scenario's declared
`observers` — see **Reader** in the glossary — as read-only participants, and
the room's permissions are pinned rather than inherited: `runRoomPowerLevels`
builds them, `establishRunRoomPermissions` writes them as an
`m.room.power_levels` state event once the room exists and reads them back,
refusing the Run if what the homeserver stored is not what it was sent. A room
left at the `public_chat` preset would let every member post.

The ladder seats the setup account, which owns the room, at 100 in `users` and
every agent at 50. The agents are high enough to clear `events_default`, which
is 50 too, so they can speak; neither `m.room.message` nor `m.reaction` is
named in `events`, so both fall to that threshold. A Reader is nobody in
`users` and so inherits `users_default` of 0 by construction, which is what
makes the bar structural — nothing on the invite path can name a Reader, so
none can be seated above `events_default` — and it clears nothing, leaving it
able to read the room in full yet refused every message and reaction.
Everything that decides who else is in the room, or what the room is, sits
above the agents: `invite`, `kick`, `ban` and `redact`, and the events
`m.room.name`, `m.room.topic`, `m.room.avatar`, `m.room.canonical_alias`,
`m.room.history_visibility`, `m.room.encryption`, `m.room.tombstone` and
`m.room.server_acl`, all at 100.

`state_default` is 100 as well, and that is the load-bearing number. An agent
at 50 that cleared a `state_default` of 50 could send an
`m.room.power_levels` state event, rewrite the room to give itself 100, and
void the entire guarantee this decision exists to establish.
`m.room.power_levels` is therefore named at 100 in `events` as well as left
covered by `state_default` — belt and braces, so the anti-escalation key is
visible in the literal and the read-back asserts it independently of the
threshold around it. What the levels deliberately do not say is as much a part
of them: `m.room.message` and `m.reaction` are named nowhere, because pinning
them at 50 would only restate `events_default` and add a second number to keep
in sync, and `notifications` is omitted because it bears on no criterion
here.

## Considered Options

- **One room per bootstrap, reused across Runs.** Simpler, and it kept a
  single continuous conversation to watch. Rejected because it contradicts the
  Run definition in the glossary and lets a Run inherit a prior conversation.
- **Rely on the Reader's discretion rather than power levels.** A Reader at the
  default level 0 alongside the agents can post, and one stray message would
  land in the transcript and likely draw agent replies — contaminating the very
  phenomenon the Run exists to observe.
- **A separate observation room, bridged or mirrored.** Zero risk to the
  experiment, but the Reader would not be reading the actual room, and the
  bridge itself becomes a thing to maintain.
- **Store the Reader's access token in `credentials.yaml`** so tooling could act
  as them. Rejected: inviting needs only a user ID, and the file already holds
  one access token per agent alongside the LLM API keys.
- **`initial_state` on `createRoom`** instead of an explicit state event after
  creation. Rejected because how a caller-supplied power_levels event merges
  with the creator's implicit level 100 is homeserver-specific, and the repo
  does not pin a Synapse version.
- **Write the state event after creation, now that the levels make the merge
  moot.** The levels do remove the merge as a variable: the setup account is
  named at 100 in `users` rather than leaning on the implicit 100 a creator is
  given, so the outcome is the same whether the homeserver merges the event
  into the creator's or replaces what it had. The rejection stands on a
  different ground. The state is written with the Runner's intent and read
  back, and a Run that has to trust a homeserver's handling of a create-time
  event is a Run that cannot show what its room ended up holding.

## Consequences

- `matrixRoomId` leaves `credentials.yaml`: it is now a per-Run value, known
  only to the runner and passed down to the seed step and the compose
  generator. `credentialsFileSchema` and its tests change accordingly.
- The runner needs the setup account's token to create each room and admit its
  members, so provisioning no longer finishes at bootstrap time.
- Rooms accumulate on the homeserver, one per Run, each named
  `Agora - <scenario> - <runId>` so a Reader can match a room to its
  `logs/<runId>/events.jsonl`. The `runId` is `formatRunId`'s readable UTC
  `YYYYMMDD-HHMM` stamp — `Agora - remote-work-policy - remote-work-policy-20251001-1420`
  — rather than epoch milliseconds, precisely so a Reader can tell two Runs of the
  same Scenario apart by eye (and sort them by time) without decoding a number.
- A Reader is invited per Run and never auto-joins, because the runner holds no
  token for them; a human accepts the invite once per room.
- Because the agents have no member-list tool and a Reader never speaks, a
  Reader is not observable by the population it is watching.
- The levels are asserted rather than assumed: `roomPermissions.test.ts` pins
  every number, and the read-back compares only the keys the harness set and
  the entries it put in the maps, so a homeserver's own added defaults do not
  abort a Run while a level that moved does. Nothing has yet exercised the
  write against a live homeserver, so what is recorded here is what the code
  asks for rather than something a Run has been seen to get.
