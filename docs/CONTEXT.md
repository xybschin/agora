# Agora

A harness for running populations of isolated, Docker-based LLM agents that
chat together in a Matrix room, so that human-group phenomena (starting
with opinion polarization) can be observed and reviewed after the fact.

## Language

**Scenario**:
A YAML definition (`scenarios/<name>.yaml`) describing a topic, seed message,
tick/budget limits, and the roster of agents (with personas and initial
stances) for a simulation. A Scenario has no conversation of its own — it's
a template that produces a new conversation each time it's executed. Its
`seedAuthor` names the agent in the roster that posts the seed message: the
runner posts it with that agent's account before any agent acts, so the
author reads the seed as its own message (and it opens the author's **Own
message history**) while everyone else, the Moderator included, reads it as
another participant's.
_Avoid_: Simulation config, experiment definition

**Run**:
One execution of a Scenario. Identified by `runId`, formed as
`<scenario-name>-<timestamp>` (see `packages/runner/src/index.ts`). Each Run
produces its own transcript at `logs/<runId>/events.jsonl` — the same
Scenario run twice yields two independent Runs with different
conversations. A Run belongs to exactly one Scenario, recovered by
stripping the trailing `-<timestamp>` off its `runId`.
_Avoid_: Session, execution, simulation instance

**Run status**:
The outcome of a Run, read off its transcript rather than stored separately.
Exactly one of **aborted**, **completed**, or **incomplete**:

- **aborted** — the transcript carries a `run_aborted` event: the room
  refused the permissions the Scenario asked for, the token budget was
  blown, or the Run was cancelled with SIGINT/SIGTERM. The event's
  `reason` says which.
- **completed** — the transcript carries either a `run_completed` event
  (written by the runner when the Moderator decides the Run is over and
  records it, the intended and normal path) or a `moderator_ended_run` event
  (the Moderator itself records this when it sends its closing message).
  Success is *recorded*, never inferred from tick count or activity level:
  a Run whose last events landed and then died before recording completion
  is **incomplete**, not completed.
- **incomplete** — a `run_started` event with no terminal event after it:
  the Run began and never said how it ended. A hard kill (SIGKILL, OOM)
  cannot be caught, so this is the honest signature of a crashed Run.

Wall-clock timeout (when the Run exceeds `maxRuntimeMs`) is also an
abortion path and records `run_aborted` with reason "wall-clock timeout",
the backstop safety limit when neither the agents nor the Moderator bring
the Run to closure.

Transcripts written before `run_started`/`run_completed` existed carry
neither, and are the one exception: for those, completion falls back to
"the highest tick seen equals the Scenario's final tick", so older Runs
keep their original verdict.
_Avoid_: Run state (state suggests something mutable/live; status here is a
one-time verdict computed after the fact)

**Transcript**:
The ordered sequence of `message` events for a single Run, i.e. the
conversation that took place in that Run's channel. Distinct from the full
event log (`events.jsonl`), which also carries `stance`, `usage`, and
tick-boundary events alongside the messages.
_Avoid_: Conversation log, chat history (both used informally elsewhere;
Transcript is the precise term for "just the messages")

**Reader**:
A human account declared in a Scenario's `observers` list and invited into
that Scenario's room, which can read the room's full history and receive
events live but is structurally barred from sending messages or reactions
by the room's power levels. A Reader is deliberately not in the agent
roster, so it gets no container, no LLM credentials, and no tick. Because
the agents have no member-list tool and a Reader never speaks, a Reader is
invisible to the population being observed.
_Avoid_: Admin, moderator, lurker (all Matrix or chat-culture terms for
roles with capabilities a Reader does not have — an admin has *more*
power than the agents, which is the opposite of a Reader)

**Moderator**:
The setup account (also used for room creation and agent invites) joined
to the room with display name "Moderator" as a silent, active participant.
Unlike a Reader (who is read-only), a Moderator speaks exactly once per Run:
when it decides the discussion is complete and ends the Run with a closing
message. It does not post the seed message — the Scenario's seed author
does — so the Moderator posts nothing before its closing message. The Moderator is the only entity that can decide a Run is over
(outside of budget overflow or operator cancellation). It is an agent in
the sense of being always-active and participating in the room, but unlike
the conversation agents it has no persona and no stance, and its only
judgment is a series of **Assessments** — of which the first STALE one
ends the Run.
_Avoid_: Conflating with Reader (a Moderator actively participates and
decides the Run's end; a Reader is silent and observes); conflating with
the conversation agents (which argue the topic; the Moderator only judges
whether the discussion is still going)

**Assessment**:
One judgment by the Moderator of the discussion as a whole: a verdict of
**ACTIVE** (still producing new arguments, shifting positions, or open
disagreement) or **STALE** (repetitive, frozen, or disengaged), with a
short rationale. A Run accumulates many Assessments; the first STALE one is
the Moderator's decision to end it. Assessments are recorded in the event
log and shown live to the operator running the Run, never posted to the
room, so the agents cannot react to being judged.
_Avoid_: Moderator stance (a **stance** is an agent's position on the
topic; the Moderator has none), classification (names the event, not the
concept), verdict (only one part of an Assessment)

**Turn**:
One wake of an agent (or the Moderator) on room activity: it reads, may post,
and records its stance (or, for the Moderator, one **Assessment**). Turns are
numbered per agent from 1, independent across agents. In the event log an
agent's turn opens with `agent_turn_started` and closes with exactly one of
`agent_turn_ended` (it ran to completion) or `agent_turn_failed` (it threw;
the event carries the error, e.g. an LLM provider out of capacity). A failed
turn does not end the agent: it goes back to waiting for the room. An
`agent_turn_started` left unclosed means the process died mid-turn.
_Avoid_: Tick (the old global, scheduled unit; turns are per-agent and
driven by activity)

**Observer**:
A human researcher reviewing a Run's transcript after it has finished, with
no account in the room and no presence during the Run. Distinct from a
Reader, which is present in the room while the Run is live.
_Avoid_: Reader (the two are easy to conflate; they differ in *when* the
human is present, not in whether they read)

**Own message history**:
An agent's only working memory within a Run: the last few messages it has
posted, quoted verbatim in its system prompt so it recognizes arguments and
commitments it has already made and does not restate them. It is a fixed,
hardcoded per-agent queue (the last ~3 posts), not something a Scenario
configures — there is no Scenario-level "memory" field, and how much of the
*room* an agent may read is governed by the `matrix_read_room` tool's own
`limit` parameter, not by the Scenario. Agents are reminded that anything
older is still visible in the room history if they choose to read it.
_Avoid_: Scenario `memory` (an old tick-era field, removed; it conflated the
agent's own commitments with the room). The real memory is this queue.

## Example dialogue

> **Dev**: Can I see the conversation for the remote-work-policy run?
> **Domain expert**: Which Run? There are four Runs of that Scenario —
> `remote-work-policy` is just the template, it ran four separate times.
> **Dev**: The most recent one. Did it finish?
> **Domain expert**: Check its Run status — completed means the transcript
> carries a `run_completed` event, which the runner writes only once every
> tick has actually run. If there's no terminal event after the
> `run_started` one, it never said how it ended, so it's incomplete.
> **Dev**: Got it. And the "conversation" is just the Transcript — the
> messages, not the stance or usage events sitting alongside them.
> **Dev**: I added myself to the remote-work-policy Scenario so I could
> watch it live. I'm a Reader now, right?
> **Domain expert**: You're a Reader if you're in the Scenario's `observers`
> list — invited to the room, able to read everything, but the power levels
> reject any message you try to send. You'd be an Observer only if you were
> waiting to look at the transcript afterwards.
> **Dev**: And the agents can't tell I'm there?
> **Domain expert**: They can't. A Reader isn't in the roster, so it has no
> container and no tick, and the agents have no member-list tool to enumerate
> the room with. Since it also never speaks, nothing it does reaches the
> Transcript. That's deliberate — the whole point is to watch a phenomenon
> without becoming part of it.
