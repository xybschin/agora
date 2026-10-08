---
status: accepted
---

# Always-active agents with a silent Moderator, replacing per-tick global scheduling

A Run used to execute in discrete tick steps bracketed by the runner's
global metronome: `tick_start`, a batch of agents' LLM calls, tool-call
rounds, `tick_end`, wait for the next scheduled tick, repeat. The runner
polled every agent on a fixed interval, and a tick's completion was
determined by the runner reaching the final tick number defined by the
Scenario. This decision records the shift to always-active, event-driven
agents with a single silent Moderator account that participates in the room
and decides when the Run is complete.

## Considered Options

- **Free-running agentic loop with no bounded wake-ups.** Each agent runs
  its own continuous loop that processes room messages as they arrive, with
  no sleep or polling delay. Rejected: unbounded activity can spiral into
  runaway tool calling or unchecked latency; a wall-clock or activity-driven
  wake-up is necessary for safety and observability.
- **Fixed polling interval instead of activity-driven wake-ups.** Agents
  poll the room on a schedule rather than blocking on activity. Rejected:
  event-driven is more responsive and cleaner: the agents wake when something
  happens rather than on the schedule, and the per-turn message can actually
  say "N messages since your last turn" instead of "we waited 10 seconds".
- **New dedicated Moderator account (LLM-driven, separate from setup).** A
  fresh Matrix account, given credentials and running as a second type of
  agent, making independent LLM calls to assess the discussion and decide
  closure. Rejected: the setup account already owns the room and manages
  agent invites. Repurposing it as the Moderator keeps account management
  simple, avoids one more credential, and the Moderator needs no LLM calls —
  it is silent and only reads.
- **Message or token-count backstop instead of wall-clock timeout.** Let the
  Run stop when it hits a message count threshold or token count ceiling
  instead of a time limit. Rejected: wall-clock is predictable, real-time,
  and human-interpretable; token count requires running LLM calls first to
  know if the next call would overflow; message count is too coarse-grained
  and does not account for the cost of long agent processing chains.
- **No Moderator; agents decide their own completion via a stop signal.**
  Each agent posts a "ready to stop" signal when it judges the discussion
  complete, and the Run ends when N agents agree. Rejected: agents would need
  consensus logic, and it puts the Run's termination in the hands of the
  population being observed rather than an independent judge; the Moderator
  is the judge precisely so it is not part of the phenomenon.

## Reversal: Heartbeat Event

ADR-0005 rejected a heartbeat event as redundant machinery: the per-tick
`tick_start`/`tick_end` brackets already provided liveness evidence, and a
silent gap was legible from the last event's timestamp without a new event
type. That decision is now reversed.

**Why it no longer holds:** The tick bracket is being removed entirely. In
the old world, every tick was bracketed, so a Run was always either mid-tick
or waiting-for-next-tick — a clear state. In the new world, agents are
always-active and event-driven, with no global tick to bracket them. The
gap is no longer "a Run is wedged with no tick in flight"; it is "an agent
is unreachable or stuck in a long LLM call, but we do not know which until
it misses several room activity windows". An `agent_heartbeat` event
recording "I am waiting for activity" or "I am actively processing" every
30 seconds (or every timeout reset) recovers liveness evidence without
inventing a new notion of "tick." It also provides the Moderator with a
clear signal of agent liveness when deciding whether the discussion is
stale.

**Consequences:** Each agent (and the Moderator) emits an `agent_heartbeat`
event periodically while waiting for room activity, declaring whether it is
in "waiting" or "active" state. A silent agent that misses heartbeats is
observable in the transcript without needing to compare timestamps. The
Moderator uses these heartbeats as part of its assessment of whether the
discussion has stalled.

## Consequences

- **Event ordering is now per-Run sequence, not per-tick.** The global tick
  was the unit of sequencing; every event's `tick` field named which tick it
  belonged to. With no global tick, events are sequenced by a monotonic
  per-Run `seq` assigned by the event-log writer at append time (see
  `packages/shared/src/events.ts`). Readers of a transcript now iterate in
  sequence order rather than grouping by tick.
- **Per-agent liveness is bracketed by `agent_turn_started`/`agent_turn_ended`
  and heartbeats, not by `tick_start`/`tick_end`.** Each agent's turn is its
  own unit of activity (see **Turn** in the glossary, updated in
  `docs/CONTEXT.md`). The per-agent turn counter is monotonic within a Run
  and independent per agent, replacing the shared global tick. Heartbeat
  events fill the gaps between turns.
- **Wall-clock safety backstop replaces tick-count-based limits.** The
  Scenario now defines `maxRuntimeMs` (wall-clock duration) instead of
  `ticks` (a count of discrete bracket pairs). Tool-calling limits are now
  per-turn (`maxToolStepsPerTurn`) instead of per-tick, reflecting the
  event-driven model where a turn is the unit of activity. Wall-clock timeout
  aborts the Run with reason "wall-clock timeout", a backstop that fires if
  neither the agents' activity nor the Moderator's assessment brings the Run
  to closure in time.
- **The Moderator is the only entity that can decide Run completion.**
  Outside of budget blow-out or operator cancellation, only the Moderator
  records a terminal event ending the Run. It reads the transcript and recent
  room activity, classifies the discussion as ACTIVE or STALE, and when STALE,
  posts a closing message and records `moderator_ended_run`. This makes the
  Run's termination an observable, recorded decision rather than a
  side-effect of hitting a tick number.
- **Agents no longer poll a fixed schedule.** Each agent runs a continuous,
  event-driven loop that blocks on `matrix_wait_for_activity` (a long-poll
  tool that times out after 30 seconds). When new room activity arrives, the
  agent wakes and takes a turn. When nothing arrives by the timeout, the agent
  heartbeats and goes back to waiting. This is more responsive than a fixed
  tick interval and uses fewer homeserver round-trips.
- **The Moderator is silent until the end.** It joins the room with display
  name "Moderator" so agents and Readers can see it is present, and it
  periodically heartbeats to signal liveness. It reads the transcript and room
  state continuously (driven by the same event-driven loop as agents), but
  makes no LLM calls and posts no messages or reactions until the moment it
  decides the Run is complete. At that moment it posts exactly one message: a
  closing statement explaining why the discussion is stale and how the agents
  performed, then records `moderator_ended_run` and its own exit from the loop.
- **New event types support the model:** `agent_turn_started` / `agent_turn_ended`
  bracket each agent's turn (replacing the global `tick_start`/`tick_end`);
  `agent_heartbeat` signals liveness (waiting or active); `moderator_classification`
  records the Moderator's ACTIVE/STALE assessment; `moderator_ended_run` records
  the Moderator's closing message and the Run's end. Existing event types
  (`message`, `stance`, `usage`, `run_started`, `run_aborted`, `run_completed`)
  are unchanged.
- **The Moderator's closing message is observed by all.** Because the Moderator
  posts to the room as a participant (not as a side-effect), agents and Readers
  see it in the same chat history, and it lands in the transcript like any other
  message. The content is deterministic and explains the closure (stale
  discussion, agent performance summary), so the agents' final state is
  influenced by that message (they see it arrive and may react to it, though the
  Run is ending so most do not take another turn).
- **Turn numbering is per-agent and per-Run.** Each agent's first turn in a Run
  is turn 1, its second turn is turn 2, etc., independent per agent. There is
  no global turn count. This makes the liveness bracket (`agent_turn_started` +
  `agent_turn_ended` + periodic `agent_heartbeat`) self-contained per agent and
  interpretable even when agents take turns at different rates.

## Comparison to the Tick Model

The shift from ticks to always-active agents can be summarized:

| Aspect | Old (Tick-based) | New (Always-active) |
|--------|------------------|---------------------|
| Scheduling | Global tick metronome, runner calls agents on fixed interval | Event-driven long-poll, agents wake on room activity |
| Liveness signal | `tick_start` / `tick_end` bracket per tick (global) | `agent_heartbeat` + `agent_turn_started` / `agent_turn_ended` (per-agent) |
| Sequence reference | Tick number (e.g., events in tick 3) | Per-Run monotonic `seq` (e.g., events 42-63) |
| Run length | Fixed tick count (e.g., 20 ticks) | Wall-clock limit (e.g., 200 seconds); soft endpoint when Moderator says so |
| Tool-call cap | Per-tick limit (e.g., 5 tool calls per tick) | Per-turn limit (e.g., 5 tool calls per turn) |
| Completion decision | Runner (reaches final tick number) | Moderator (reads activity, decides STALE, posts message) |
| Backstop timeout | None (tick count is the limit) | Wall-clock (e.g., 200 seconds max) |

## Rationale

The shift addresses three needs that the tick model could not meet:

1. **Responsiveness:** Agents waiting 10 seconds for the next tick slot do not
   match the actual room activity. Event-driven wake-ups reduce latency and
   let the per-turn message accurately report "5 new messages since your last
   turn" rather than "it is your turn again" on a schedule.
2. **Observation without participation:** The original design needed a global
   tick so all agents could be synchronized and the runner could observe their
   collective progress. With per-agent always-active loops, agents are
   synchronized only by room activity and each other's messages, making the
   room itself the observable unit (not a tick bracket imposed from outside).
3. **Independent judgment of completion:** A Run should end when the discussion
   naturally reaches a conclusion or stalls, not when the tick count hits an
   arbitrary number. The Moderator reads the actual activity level and can
   distinguish a stale discussion (no new substantive points) from a brief
   pause, making the verdict a human-like judgment rather than a tick counter.

## Amendment (2026-10-08): what the code actually does

Several statements above did not survive implementation. The decision —
always-active, event-driven agents and a Moderator that alone judges when the
discussion is over — stands; these details are corrected:

- **The Moderator makes LLM calls.** Each Assessment is an LLM call (using the
  first roster agent's endpoint and model, and the Scenario-wide sampling), and
  the closing message is written by the model, not deterministic. Its calls
  append `usage` events attributed to `moderator`, which the token budget
  counts. The rejected "dedicated Moderator account" option stays rejected for
  its account-management reasons; only its "needs no LLM calls" premise was
  wrong.
- **The runner writes the terminal event.** The Moderator does not record
  `moderator_ended_run`. After posting its closing message it records the
  non-terminal `moderator_closing_posted`; the runner, watching the
  transcript, writes the single `moderator_ended_run` (ADR-0005's ownership
  rule).
- **An Assessment's event.** `moderator_classification` is written for every
  valid verdict the model returns, and a STALE verdict refused because not
  every agent has spoken yet is recorded as ACTIVE.
- **`seq` is per writing process, not per Run.** Each container numbers its
  own events from 1, so `seq` repeats within a Run. The only order across
  processes is line order in `events.jsonl`, which is what the runner reads.
- **Heartbeats.** Agents emit `agent_heartbeat` only in the `waiting` state,
  once per wait; the Moderator emits `active` when an Assessment starts and
  `waiting` while it waits. The Moderator judges liveness from agents' open
  Turns (`agent_turn_started` with no matching end), not from heartbeats.
- **Wall-clock abort reason** is "wall-clock runtime limit exceeded".
