---
status: accepted
---

# Run artefacts are kept forever by default, and reclaimed only by an explicit command

Every Run leaves two artefacts the harness never reclaims: the transcript under
`logs/<runId>/` on disk, and the Run's Matrix room on the homeserver. Before
this decision, neither was ever deleted, but "keep everything forever" was an
accident, not a policy — nothing had said what to keep, for how long, or when
deletion was acceptable. This records the deliberate answer: **keep everything
by default, forever, and delete only via an explicit, operator-invoked command
that names the exact Run and the exact artefact.** There is no auto-expiry, no
retention window, and nothing ever deletes anything during a Run.

The two artefacts are not equally replaceable. The transcript is a file; the
Matrix room is the thing the whole harness exists to produce — it is the only
place the group dynamics actually happened, and deleting it destroys the
conversation permanently. That asymmetry is why the default leans so hard
toward keeping: for a research harness whose raw material is its room history,
the cost of keeping a room forever is disk on a homeserver nobody is paying to
save, while the cost of deleting it pre-emptively is an experiment that can
never be re-examined. When neither cost is pressed, keep.

Reclamation is therefore the exception, and it is shaped so the exception
cannot be reached by accident:

- **Explicit and named** — `packages/runner/src/reclaim.ts` is a separate
  entrypoint from the normal run path; a Run can never trigger it. It does
  nothing unless an operator names a `runId` (or all eligible Runs) *and* a
  target (`--logs` and/or `--room`).
- **Gated on a terminal verdict** — a Run is reclaimed only when its transcript
  records a terminal event (`run_completed` or `run_aborted`). A transcript
  with no terminal event is `incomplete` — ADR-0005's ambiguous hard-crash
  signature — and is never eligible, because at that point no one can say
  whether the Run simply died mid-flight. Under ADR-0001 we read the logs, not
  a metadata store, so this verdict is derived from `logs/<runId>/events.jsonl`
  at reclaim time; we never introduce an index that could drift from the source
  of truth.
- **Joins a Run to its room by name, not by message** — a Run's room is
  resolved from its `runId` via the room-name convention (`roomNameForRun`,
  "Agora - <scenario> - <runId>", per ADR-0003) against the homeserver's public
  room directory, using the setup account's token. It is *not* resolved from
  `message` events: the room id appears on `message` events only, so a Run that
  never sent a message would have no room id in its transcript, and the
  name-based join always holds.

## Considered Options

- **Keep everything, forever, silently.** Rejected only for being a non-
  decision: it is the behavior, but not a policy, so nothing stops a future
  change from pruning on a guess. This ADR makes it a decision, and adds the
  explicit escape hatch.
- **Auto-expire after a window.** Rejected: a retention window is auto-deletion
  of a resource that can be irreplaceable, and it runs without an operator
  inspecting what is being discarded. For a research harness the risk/reward of
  guessing is backwards.
- **Reclamation from a metadata index.** Rejected under ADR-0001: Run status is
  derived, not stored, and a second source of truth for data recoverable from
  `events.jsonl` drifts out of sync. The claim of terminality must be read off
  the transcript at the moment of deletion, not from a stale record.
- **Resolve the room from the transcript's `message` events.** Rejected because
  the id lives only on `message` events. The room-name convention is the join
  that holds for every Run, message or not.

## Consequences

- The repository now names a retention policy: keep everything by default;
  delete only explicitly.
- An operator wishing to reclaim a specific finished Run runs the `reclaim`
  entrypoint with a `runId` and a target. Deleting a room or `logs/<runId>`
  that a Run did not record ending with (`incomplete`) is refused.
- Nothing in the normal run path (`index.ts`) calls reclamation, so no Run can
  delete its own or another Run's artefacts.

## Amendment (2026-10-08): terminal events and references

- The terminal events that make a Run eligible are now `moderator_ended_run`
  (the normal completion, see ADR-0005's amendment), `run_completed` (older
  transcripts only) and `run_aborted`. An `incomplete` Run is still never
  eligible.
- ADR-0001, cited above for "read the logs, not a metadata store", is
  superseded by ADR-0004. The principle stands on its own here: Run status is
  derived from `logs/<runId>/events.jsonl` at reclaim time, as
  `docs/GLOSSARY.md` defines it.
- Room deletion now goes through Synapse's admin API with a separate
  server-admin credential, deletes the room before the logs, and resolves the
  room by name through the admin room list rather than the public room
  directory, which the dev Synapse never populated. See ADR-0009.
