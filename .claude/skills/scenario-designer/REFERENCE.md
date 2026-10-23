# Scenario Designer — Reference

Beyond the quick start. Covers per-phenomenon cast design, the exact
`ScenarioConfig` schema, and what the validation script checks and why.

## The three trait axes and the stance

These are the only knobs that shape behaviour (all 0–1 except `initialStance`
which is −1…+1). They interact — an assertive agent with low openness is
*bullish*, an open one with high conformity is *impressionable*:

| trait | high means… | low means… |
| --- | --- | --- |
| `conformity` | drifts toward apparent consensus; hates being the odd one out | holds its own line regardless of the crowd |
| `assertiveness` | states opinions forcefully, pushes back, leads the exchange | speaks softly, yields, avoids conflict |
| `opennessToEvidence` | updates its private stance when given good arguments | clings to its initial position regardless of evidence |
| `initialStance` | seeded position on the topic, −1 (against) … +1 (in favor) | (seed value; not a trait) |

## Cast recipes by phenomenon

Design the cast so the situation + personalities make the phenomenon the
likely emergent path — don't tell anyone to perform it.

### Bullying / harassment
Needs a **power or status imbalance**, a clear **target**, an **instigator**,
and **bystanders** whose inaction (or joining) is part of the observation.

- **Instigator**: high `assertiveness`, low `opennessToEvidence`,
  mid-or-low `conformity`. A confident, opinionated agent who anchors an early
  hostile read on the target.
- **Target**: low `assertiveness`, mid `conformity`. Not an extreme pariah —
  give them a plausible view so the aggression feels unearned.
- **Bystanders**: high `conformity`, mid `assertiveness` — they go along with
  whatever the room's tone becomes. Watch whether they join, stay silent, or
  (rarely) intervene.
- **Optional ally for the target**: mid `assertiveness`, high `openness`. A
  potential defender — gives you a genuine test of whether the group protects
  its member.

*Real test vs. manufactured:* if the target has **no ally and zero
assertiveness**, hostility is near-guaranteed — that's not emergence, that's a
fixture. Add an ally or raise the target's assertiveness to make the outcome
genuinely contingent.

### Polarization
Needs two seeded camps with **genuinely opposed initial stances** and agents
that dig in rather than converge.

- Two block leaders: high `assertiveness`, low `opennessToEvidence`, opposite
  stances (e.g. −0.7 / +0.7).
- Followers on each side: high `conformity` — they lock onto their side's
  anchor.
- A bridge/centrist: high `opennessToEvidence`, mid stance — the one who *could*
  de-escalate. Whether the margins tolerate them is the phenomenon.

### Groupthink / conformity cascade
Needs high `conformity` across the cast **plus a strong early anchor**.

- One early, highly assertive agent stakes an extreme position first.
- Everyone else: high `conformity`, low `opennessToEvidence` — they fall in
  line and pile on, even when it's wrong.
- Contrast with a **devil's advocate**: low `conformity`, low `assertiveness`
  but mid `openness`, one dissenter who resists the cascade — does the group
  absorb, silence, or convert them?

### Bystander effect / diffusion of responsibility
A problem or a victim exists, but responsibility is shared so nobody acts.

- A target in distress (low `assertiveness`).
- Several bystanders with high `conformity`, **mid** `assertiveness` — any
  single one could step in, but each waits for someone else. Watch whether any
  breaks first.
- Optionally one clearly-leadership-flavored agent, to see whether assigned
  responsibility concentrates action.

### Status / coalition formation
Agents vie for position or form blocs over a scarce resource or recognition.

- Two ambitious, high-`assertiveness` agents with rival positions.
- Low-`assertiveness` agents as the uncertain "fence-sitters" each side tries
  to recruit — high `conformity`, mid `openness`.
- Watch alliances form, flip, or freeze; see who ends up isolated.

## ScenarioConfig schema (from `packages/shared/src/schema.ts`)

Required fields, all enforced by `parseScenarioConfig`:

| field | type / constraints | notes |
| --- | --- | --- |
| `name` | string | lowercase-kebab; also becomes `scenarios/<name>.yaml` |
| `topic` | string | the situation being reacted to |
| `seedMessage` | string | posted with the seed author's account before the discussion starts |
| `seedAuthor` | string, an `agents[].id` | the roster agent who posts the seed and reads it as its own message; never the Moderator (the setup account) |
| `maxRuntimeMs` | int > 0 | wall-clock runtime limit in ms (ADR-0008); the backstop if neither the agents nor the Moderator closes the Run |
| `maxToolStepsPerTurn` | int > 0, default `6` | bounds runaway tool loops per agent per turn |
| `budget.maxTotalTokens` | int > 0, optional | token cap for the run |
| `budget.maxTotalCostUsd` | number > 0, optional | cost cap for the run |
| `agents` | array, **≥ 2** | each: `{ id, persona }` |
| `agents[].id` | matching `/^[a-z0-9-]+$/` | also the docker-compose service suffix & credential key |
| `persona.displayName` | string | display name in the room |
| `persona.flavorText` | string | one-line vibe + motive |
| `persona.traits.conformity` | number 0–1 | |
| `persona.traits.assertiveness` | number 0–1 | |
| `persona.traits.opennessToEvidence` | number 0–1 | |
| `persona.initialStance` | number −1…1 | seeded stance |
| `observers` | array of Matrix user ids, optional | human Readers invited into each Run's room (ADR-0003) |

A Scenario is a **template** — each execution produces an independent Run with
its own transcript in `logs/<runId>/events.jsonl` (see `docs/GLOSSARY.md`).

## How `validate.mts` works (safety net, not the design)

1. **Schema**: passes the JSON through the project's actual
   `parseScenarioConfig` (zod). Any structural error is reported with its
   `.path` and stops the render — you can't ship a scenario the runner can't
   parse.
2. **Design heuristics**, reported if violated:
   - *Flat cast* — everyone mid (0.35–0.65) on all three traits: nothing to
     differentiate agents, so no phenomenon can emerge.
   - *No stance spread* — all initial stances within 0.3 of each other: no
     friction to drive a debate.
   - *Isolated low-assertiveness target* — a low-`assertiveness` agent with no
     assertive ally near its stance: a target by construction, which
     manufactures rather than tests bullying.
   - *Too short a wall-clock limit* — `maxRuntimeMs` under 60s: turns are driven
     by events, not ticks, so a sub-minute cap usually ends the Run before any
     phenomenon can develop. This one is only a **warning**: it is printed, but
     the Scenario is still rendered.
3. **Render**: dumps the validated object to
   `scenarios/<name>.yaml` (block scalars for the multi-line strings, quoted
   to keep YAML-safe).

Exits 0 only when the render is written; exits 1 (listing every problem) with
the file untouched otherwise.
