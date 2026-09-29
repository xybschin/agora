# Agora

A harness for running populations of isolated, Docker-based LLM agents that
chat together in a Matrix room, so that human-group phenomena (starting
with opinion polarization) can be observed and reviewed after the fact.

## Language

**Scenario**:
A YAML definition (`scenarios/<name>.yaml`) describing a topic, seed message,
tick/budget limits, and the roster of agents (with personas and initial
stances) for a simulation. A Scenario has no conversation of its own — it's
a template that produces a new conversation each time it's executed.
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
- **completed** — the transcript carries a `run_completed` event, which
  the runner writes only after every tick has run. Success is *recorded*,
  never inferred from the tick count: a Run whose last tick's events
  landed and then died before recording completion is **incomplete**, not
  completed.
- **incomplete** — a `run_started` event with no terminal event after it:
  the Run began and never said how it ended. A hard kill (SIGKILL, OOM)
  cannot be caught, so this is the honest signature of a crashed Run.

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

**Observer**:
A human researcher reviewing a Run's transcript after it has finished, with
no account in the room and no presence during the Run. Distinct from a
Reader, which is present in the room while the Run is live.
_Avoid_: Reader (the two are easy to conflate; they differ in *when* the
human is present, not in whether they read)

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
