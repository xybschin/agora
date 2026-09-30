# agora

A harness for running populations of isolated, Docker-based LLM agents that
chat together in a Matrix room, to see whether human-group phenomena
(starting with opinion polarization) emerge from the interaction.

## Architecture

- **`packages/mcp-server`** -- one shared MCP server (Streamable HTTP) exposing
  Matrix tools (`matrix_read_room`, `matrix_send_message`,
  `matrix_add_reaction`). Every agent authenticates with its own access token
  via the `Authorization` header; identity is bound to that token, never
  passed as a tool argument, so agents can't impersonate each other.
- **`packages/agent`** -- one process per agent (one container per agent at
  runtime). Runs a true tool-calling loop each tick: the model itself decides
  when to read the room, post, and record its stance, up to
  `maxToolStepsPerTick` steps. Exposes `POST /tick` and `GET /health`.
- **`packages/runner`** -- the CLI (`agora <scenario.yaml>`) that: creates a
  fresh Matrix room, pins its permissions so the scenario's declared Readers can
  read the Run but not post to it, and posts the seed message, generates a
  docker-compose file for the scenario, brings the containers up, drives
  fixed-tick round-based scheduling (all agents ticked in parallel, then a
  sleep, repeat), enforces the token budget cap, and tears everything down.
- **`packages/shared`** -- scenario/credentials schemas (zod) and the shared
  JSONL event log used by both the runner and every agent container.
- **`docker-compose.infra.yml`** -- a persistent (not per-scenario) Matrix
  stack: Synapse (`matrixdotorg/synapse`) backed by PostgreSQL, Element Web
  (`vectorim/element-web`) as the web client, and an Nginx reverse proxy that
  routes `/` to Element Web and `/_matrix` / `/_synapse` to Synapse. Used
  instead of a hosted chat service so "bots" are just accounts on your own
  instance -- no developer portal, no rate limits, no ToS risk. The previous
  Discord/Spacebar backend was replaced by this stack (see
  `docs/matrix-db-decision.md` and `docs/matrix-proxy-decision.md`).

### Isolation model

Each agent gets its own dedicated Docker network that only it and
`mcp-server` join. Agents never share a network with each other, so there is
no route between them -- any influence you observe in the logs happened
*through the simulated Matrix room*, not a side channel. `mcp_server`
additionally joins the persistent `agora_infra` network so it can reach
Synapse (see `composeGenerator.ts`).

## One-time setup (Matrix, recommended)

1. `bun install` at the repo root.
2. `docker compose -f docker-compose.infra.yml up -d` -- brings up the
   self-hosted Matrix stack (Synapse + PostgreSQL + Element Web + Nginx) with
   Element Web reachable at `http://localhost:8000` and the Matrix client/federation
   API proxied under `/_matrix`. Backed by named volumes so data survives
   restarts.
3. `bun run bootstrap:matrix scenarios/remote-work-policy.yaml` -- registers
   one account per agent (+ a setup account) and writes the result to
   `credentials.yaml`. It creates no room: every Run creates its own (see
   "Running a scenario"), so there is nothing to re-provision between runs.
4. Open `credentials.yaml` and fill in each agent's `llmApiKey` (the Matrix
   side is already done by step 3). Also set the shared secrets in
   `docker/matrix/homeserver.yaml` before first boot.

## One-time setup (hosted Matrix, alternative)

If you'd rather use a hosted/remote Matrix homeserver instead of the local
Docker stack:

1. Create one account per agent in your scenario, plus one extra "setup"
   account with permission to create and join rooms.
2. Copy `credentials.example.yaml` to `credentials.yaml` (gitignored) and fill
   in the setup account's `matrixSetupUserId` / `matrixSetupAccessToken` and
   each agent's `matrixUserId` / `matrixAccessToken` / `llmApiKey`. For the
   `matrix:` block, set both `hostBaseUrl` and `containerBaseUrl` to your
   homeserver's public URL -- the two differ only on the self-hosted stack,
   where the mcp_server container reaches Synapse by DNS name. The block is
   required either way; nothing about it selects a remote homeserver.
3. `bun install` at the repo root.

## Running a scenario

```sh
bun run packages/runner/src/index.ts scenarios/remote-work-policy.yaml
```

Bun runs the TypeScript directly -- there's no build/compile step. Use
`bun run --filter '*' typecheck` to type-check everything without running
it.

This creates a fresh Matrix room, posts the seed message, starts the
containers, runs the configured number of ticks, then tears the containers
down. Nothing is deleted from the homeserver -- the room and transcript stay
there for review.

Each Run gets its own room, named `Agora - <scenario> - <runId>`, so running
the same Scenario twice yields two independent conversations: an agent in the
second Run starts from a room with no history rather than reading the first
Run's transcript. Rooms therefore accumulate on the homeserver, one per Run;
the `runId` in the name matches the transcript under `logs/<runId>/`, which is
how you tell them apart. To re-run a Scenario you do not need to re-bootstrap --
bootstrap the accounts once, then run as many times as you like.

Per-run JSONL logs land in `logs/<runId>/events.jsonl` (message, stance, and
usage events).

### Reclaiming a finished Run

Artefacts are kept forever by default. Nothing is auto-expired, and nothing
deletes during a Run. When you want to reclaim a specific finished Run's room
and/or logs, do so explicitly (see ADR-0006):

```sh
bun run packages/runner/src/reclaim.ts <runId> --room --logs
```

This removes `logs/<runId>/` off disk and deletes the Run's Matrix room
(resolved by its `Agora - <scenario> - <runId>` name). It refuses any Run whose
transcript has no terminal event (`incomplete`), because that is the ambiguous
case. Without a target (`--room` and/or `--logs`) it does nothing. Use
`--all-eligible` instead of a runId to select every completed/aborted Run.

### Watching a Run live

A Scenario can name human **Readers** in an optional `observers` list -- Matrix
user ids of accounts that already exist on the homeserver:

```yaml
observers:
  - "@admin:localhost"
```

Every Run invites each Reader to that Run's room, and writes the room's power
levels before it does: agents sit above the room's default event threshold so
they can post, while invite, kick, ban, redaction and the room's metadata events
sit above the agents, leaving a Reader at the default level -- able to read the
whole conversation as it happens, and refused by the homeserver when it tries to
send a message or a reaction. A Reader accepts the invite themselves, once per
room; the runner holds no token for them, so there is nothing to add to
`credentials.yaml`. A Reader is not in the roster, so it gets no container, no
LLM credentials and no tick, and the agents have no member-list tool to notice
it -- it is invisible to the population it is watching. (Someone reading the
finished transcript afterwards needs none of this; they are an **Observer**.)

The runner reads the power levels back after writing them and refuses to
continue a Run whose room did not end up holding what it asked for. That
refusal is recorded as a `run_aborted` event at tick 0 in
`logs/<runId>/events.jsonl`, so the Run's status is *aborted* rather than merely
incomplete.

## Known limitations / things to check before trusting a run

- `llm.ts` speaks the OpenAI-compatible `/chat/completions` schema only. It
  works against OpenAI, OpenRouter, Ollama, vLLM, etc., but **not** against
  Anthropic's native `/v1/messages` API -- route Claude models through
  OpenRouter rather than pointing directly at `api.anthropic.com`.
- The MCP server code was written against `@modelcontextprotocol/sdk@1.30.0`
  (verified against the installed package's own stateless-HTTP example). If
  `bun install` picks up a materially newer major version, re-check
  `packages/mcp-server/src/index.ts` and `packages/agent/src/mcpClient.ts`
  against that version's API.
- Runtime is Bun (`oven/bun:1-slim` in the Dockerfiles), not Node. Each
  service Dockerfile only copies its own + `@agora/shared`'s `package.json`
  before `bun install --frozen-lockfile`, so Bun prints a harmless
  `skipped N workspaces ... not on disk` note for the other packages -- this
  was verified against `bun.lock` and doesn't affect the install.
- Rate limits: ticks run all agents in parallel (Q22). If your LLM provider
  rate-limits aggressively, raise `tickIntervalMs` in the scenario file or
  pick a less-limited provider -- there's no retry/backoff built in yet.
- Matrix access tokens and LLM API keys live in plaintext env vars inside
  each generated compose file (`runner-generated/`, gitignored). Fine for a
  local research harness; do not reuse this pattern for anything
  internet-facing.
