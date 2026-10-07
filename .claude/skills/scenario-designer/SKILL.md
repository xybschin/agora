---
name: scenario-designer
description: >
  Design and generate Agora Scenario files — simulations of LLM agents with
  distinct personalities chatting in a Matrix room so that human-group
  phenomena (bullying, polarization, groupthink, conformity cascades, the
  bystander effect, status/coalition formation) can be observed afterward in
  the transcript. Use when the user asks to create, brainstorm, extend, or
  improve a scenario, or wants to see whether a social phenomenon "emerges"
  from agent interaction. Authors a structured JSON scenario and renders it
  into scenarios/ in exactly the shape the runner parses.
---

# Scenario Designer

Create `scenarios/<name>.yaml` files that get **different personalities to
interact in a charged situation**, so the transcript gives you a shot at
observing a social phenomenon. The key idea: you don't tell agents to perform
the phenomenon — you arrange personalities and context so it becomes the
*likely emergent result*, then watch whether it shows up.

## How output is produced (structured, not hand-typed YAML)

You author the scenario as a **JSON document** matching the `ScenarioConfig`
shape below. You **never hand-write YAML text**. A deterministic script
(`validate.mts`) validates that JSON against the project's **real zod schema**
and renders the `scenarios/<name>.yaml` file. The script is the safety net;
your job is the design.

```sh
# 1. draft the scenario as JSON, e.g. /tmp/<name>.json (a ScenarioConfig object)
# 2. validate + render:
bun .claude/skills/scenario-designer/scripts/validate.mts /tmp/<name>.json
# writes scenarios/<name>.yaml on success; prints schema/design errors and exits 1 otherwise
```

The script also runs **design-heuristic checks** (below) that catch casts which
would *manufacture* a phenomenon rather than *test* it.

## The structured shape to fill in

```jsonc
{
  "name": "lowercase-kebab",                 // also recapitalized into the file name
  "topic": "One-two sentence situation the room is reacting to.",
  "seedMessage": "The opening post, written in the seed author's own voice (and signed as them, if signed). Neutral-ish bait.",
  "seedAuthor": "lowercase-kebab",           // id of the roster agent who posts the seed — never the Moderator
  "maxRuntimeMs": 120000,
  "maxToolStepsPerTurn": 6,
  "budget": { "maxTotalTokens": 2000000 },
  "agents": [
    {
      "id": "lowercase-kebab",               // zod: /^[a-z0-9-]+$/ — also the docker service suffix
      "persona": {
        "displayName": "Alex",
        "flavorText": "One line: vibe + motive.",
        "traits": { "conformity": 0.3, "assertiveness": 0.7, "opennessToEvidence": 0.6 },
        "initialStance": 0.6                 // -1 (against) .. +1 (in favor)
      }
    }
    // ...2 or more agents
  ]
}
```

## Workflows

### 1. Pick the phenomenon and the situation
Agree with the user on **what** to observe and **where**. A Scenario only ever
produces a *conversation* — so choose a situation that creates tension (a
policy change, a blame assignment, a scarce resource, an in-group/out-group
split). Per-phenomenon cast recipes: [REFERENCE.md](REFERENCE.md).

### 2. Design the cast so the phenomenon can emerge
Three trait axes plus a seeded stance decide who does what (see the glossary
in `packages/shared/src/types.ts`):

- **conformity** — how strongly an agent drifts toward apparent consensus.
- **assertiveness** — how forcefully it states and defends its view.
- **opennessToEvidence** — how readily it updates its *private* stance on a
  good argument.
- **initialStance** — its seeded position (-1..+1).

Rules of thumb that make phenomena *observable* rather than noise:

- **Separate the cast.** Spread the traits out. An all-mid, all-similar cast
  produces a bland echo — the interesting stuff is the gradient.
- **Create the imbalance that precedes the phenomenon.** Bullying needs a
  target + an instigator + bystanders. Polarization needs two seeded camps with
  genuinely opposed `initialStance`s. Groupthink needs high conformity plus a
  strong, early, assertive position.
- **Give everyone a motive** in `flavorText`, so the model has a consistent
  reason to behave as its traits suggest.
- **Don't isolate a lone zero.** A single low-assertiveness agent with no ally
  is a target *by construction* — that manufactures the phenomenon instead of
  testing it. Give it an ally, or raise its assertiveness.
- **Keep `initialStance` within [-1, 1]** — the validator enforces it.
- **Pick a seed author who would plausibly post the seed.** The runner posts
  `seedMessage` with the `seedAuthor` agent's account; the Moderator never
  posts it. That agent takes part in the discussion and treats the seed as its
  own message, so write the seed in its voice and match its persona (the team
  lead announcing the meeting, the relative relaying the request). A seed signed
  by someone outside the roster has no author to post it — re-voice it to an
  agent in the cast instead. The schema rejects a missing or unknown author.

### 3. Validate and render
Run `validate.mts` (above). It checks the schema **and** the design heuristics
(flat cast, no stance spread, isolated low-assertiveness target, too short a
wall-clock limit). Fix anything it reports and re-run. It exits 0 and writes
the YAML only when everything is clean.

### 4. Confirm and run
The skill is done when `scenarios/<name>.yaml` is written and validates. The
user can then run it with `bun run run:scenario scenarios/<name>.yaml`.

## Advanced features
See [REFERENCE.md](REFERENCE.md): the per-phenomenon cast recipes, full
field-by-field schema notes, and how the `validate.mts` design heuristics work.
