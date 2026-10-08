---
status: accepted
---

# A Run's transcript records its own ending, and success is never inferred

Run status used to be derived from the absence of things. `deriveRunStatus`
reported **aborted** if the transcript carried a `run_aborted` event,
**completed** if the highest tick number seen across *any* event equalled the
Scenario's final tick, and **incomplete** otherwise. Only two paths ever wrote
`run_aborted` — a `RoomPermissionsError` out of `createRunRoom`, and an abort
*returned* by `runTicks` — so every other way a Run could stop, including a
throw from `seedRoom`, `composeUp` or `waitForHealth` and any signal, wrote
nothing at all. Cancelling a live Run by hand and then asking the log what
happened was the thing that made this visible: the transcript held 106 events
across four ticks and no verdict, and `incomplete` equally described a Run that
was still going, one that had crashed, and one an operator had just cancelled.

The inference also failed in the more dangerous direction. Completion was
concluded from the tick count alone, so a Run whose final tick's events landed
and which then died before writing its own bookkeeping reported **completed**.
An ambiguous `incomplete` at least reads as suspicious; a false all-clear
invites the opposite.

The transcript is now self-describing. The runner writes `run_started` before
anything that can fail, and exactly one terminal event per Run: `run_completed`
only once every tick has run, `run_aborted` on permission refusal, budget
blow-out, or `SIGINT`/`SIGTERM`. `deriveRunStatus` reads a verdict off that
rather than guessing. A Run with `run_started` and no terminal event is
**incomplete**, which is the honest signature of a hard kill.

A crash is the case this cannot cover, and should not pretend to: nothing
records its own death. What it gets instead is bracketing. The orchestrator
emits `tick_start` and `tick_end` either side of each tick, so a transcript
says which tick a killed Run died in, and mid-tick becomes distinguishable from
between-ticks. Both types were already declared in `AgoraEvent` with nothing
emitting them; emitting them retires a declared-but-never-written event type
that had become a trap for the next reader of the union.

## Considered Options

- **Leave the derivation alone and document how to read it.** Rejected because
  the ambiguity is not a reading problem, it is missing data. No amount of
  prose recovers whether a Run was killed or is still running.
- **Infer cancellation from the absence of recent events**, by comparing the
  last event's timestamp against now. Rejected as the basis for a verdict: it
  needs wall-clock and a threshold, so the answer changes with how long you
  look, and it cannot tell a crashed Run from a slow one. It may later be worth
  adding as a *hint* alongside a recorded verdict, never as the verdict itself.
- **Write a terminal event from an `exit`/`uncaughtException` handler** and treat
  that as covering crashes. Rejected for the same reason `SIGKILL` does not:
  an OOM kill or a `SIGKILL` runs no handler. A handler that appears to cover
  crashes but does not is worse than none, because it invites the reader to
  trust an absence that means nothing.
- **Have the orchestrator write `run_completed` itself** when the loop finishes.
  Rejected because the orchestrator returning normally is not the same claim as
  the Run having completed, and the runner is the module that owns the
  transcript. Keeping the terminal event in one place also keeps the
  ownership rule in one place.
- **Stop the tick loop by abandoning a tick mid-flight** the moment a cancel
  lands. Rejected because it strands a `tick_start` with no matching `tick_end`,
  which is the one thing the bracket exists to rule out: a reader could no
  longer tell an abandoned tick from a tick that never began. The loop is polled
  at the top of each tick instead, so a cancel ends a Run *between* ticks and the
  transcript always ends on a closed bracket.
- **A heartbeat event per tick, so liveness is recorded rather than inferred.**
  Rejected as more machinery than the problem needs: `tick_start`/`tick_end`
  already give a per-tick bracket, and the gap they leave — a Run silently
  wedged with no tick in flight — is legible from the last event's timestamp
  without a new event type.
- **Delete `tick_start`/`tick_end` from the union** instead of emitting them.
  Rejected because the diagnostic they carry is real: knowing a Run died *mid
  tick* points at the agent, where knowing only that it died at tick 4 does
  not.
- **Backfill the new vocabulary onto old transcripts** so the fallback is
  unnecessary. Rejected: rewriting a log that a human has already read would
  falsify it, and the fallback is two lines.

## Consequences

- `Run status` in `docs/CONTEXT.md` is restated as recorded rather than
  derived, and names the three outcomes and the events that produce them. This
  amends the "derived Run status" that ADR-0004 recorded as surviving
  background; the glossary, not ADR-0001, is the current statement of the
  contract, as ADR-0004 itself said.
- Transcripts written before this change carry neither `run_started` nor
  `run_completed`, and keep the tick-count inference so Runs already on disk do
  not all regress to `incomplete`. `deriveRunStatus` therefore has two paths,
  and the fallback is deliberately keyed on the absence of `run_started` rather
  than on a date.
- A cancel exits `130` for `SIGINT` and `143` for `SIGTERM`, the conventional
  shell codes, so a script can tell a deliberate cancel from a Run that
  finished. The transcript also says which signal.
- The cancel handler tears the containers down, so a cancelled Run no longer
  leaves orphans. Two races that introduces are handled rather than assumed:
  a cancel landing during the last tick would write both a `run_aborted` and a
  `run_completed` (the terminal event is claimed by whoever writes it, and the
  loser is a no-op), and the handler racing `main()`'s `finally` would run
  `docker compose down` twice concurrently against one project (teardown is
  memoised). `runLifecycle.test.ts` covers both.
- Lifecycle bookkeeping moves out of `index.ts` into `runLifecycle.ts`. It has
  to: a top-level script that calls `main()` on import cannot be tested, and
  this is the code most in need of it.
- `tick_start`/`tick_end` increase the event count per tick by two. The stance
  metric reads `stance` events, so it is unaffected.
- A cancelled Run is recorded with `tick: -1`, because the runner does not track
  the tick in flight and inventing one would falsify the record. It is safe
  because `deriveRunStatus` takes the maximum tick across events, so the
  sentinel cannot lower the count the transcript already established. The
  surrounding `tick_start`/`tick_end` pair is what says where the cancel
  landed.
- A cancelled Run's transcript ends on its terminal event. The tick loop polls
  ownership at the top of each tick, so a signal stops the Run between ticks and
  a partial `tick_start`/`tick_end` pair can no longer land *after* the abort.
  This was found by the live check below, not by inspection: the first working
  version recorded the abort correctly and then let tick 2 bracket itself around
  the teardown. The verdict was still right, because `run_aborted` is read ahead
  of everything else, but a transcript whose tail contradicts its own ending is
  what teaches a reader to stop trusting one.
- Nothing about the vocabulary depends on an agent's LLM call succeeding. A tick
  whose agents all fail still gets both boundaries, because the orchestrator
  brackets around `Promise.allSettled`. One of the three verification Runs had
  every agent error out on tick 1 and still produced a well-formed transcript,
  which is what makes this contract checkable without a working provider.
- Verified against a live Run, cancelling with a real `SIGTERM` and reading the
  transcript back: `transcript-probe-1790685273452` completed 3/3 and ends on
  `run_completed`; `transcript-probe-1790685604620` was cancelled during tick 1
  and ends on `run_aborted` with `reason=cancelled by SIGTERM`, `ticksRun` 1
  despite the `tick: -1` sentinel, and exit code 143. The pre-fix Run
  `transcript-probe-1790685350736` is kept as the counter-example: correct
  verdict, but ending on a stray `tick_end`.

## Amendment (2026-10-08): ticks and `run_completed` superseded by ADR-0008

ADR-0008 replaced the global tick with per-agent Turns, so parts of this
record describe a Run that no longer exists:

- `tick_start`/`tick_end` are no longer emitted, and the `tick: -1` sentinel
  on a cancelled Run's `run_aborted` is gone. Per-agent liveness is now
  `agent_turn_started`/`agent_turn_ended`/`agent_turn_failed` plus heartbeats.
- Nothing writes `run_completed` any more. A Run completes when the Moderator
  judges the discussion stale: the Moderator records the non-terminal
  `moderator_closing_posted` after its closing message, and the runner writes
  the Run's single terminal `moderator_ended_run`. `deriveRunStatus` and
  reclaim treat `moderator_ended_run` and `run_completed` alike, so older
  transcripts keep their verdict.
- The wall-clock limit (`maxRuntimeMs`) is a further abort path, recorded as
  `run_aborted` with reason "wall-clock runtime limit exceeded".

What this ADR decided still holds: the transcript records its own ending,
success is never inferred, the runner owns the terminal event and writes
exactly one per Run (claimed, so a racing cancel is a no-op), teardown is
memoised, and a cancel exits 130/143.
