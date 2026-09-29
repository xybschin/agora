# Issue tracker: beads (`bd`)

Issues and specs for this repo live in **beads**, a CLI issue tracker backed by Dolt.
There are no issue or spec files in the repo — `bd` is the store.

> Requires the `bd` binary on PATH, and `bd init --quiet` run once if `.beads/` is absent.
> Read with `--json` and parse it — never scrape human-readable output, which omits labels.
> Run `bd dolt push` at the end of any session that changed the tracker.

## Conventions

- **Spec** (`/to-spec`) → one `epic` issue, body in `--description`, labelled `spec`.
  No `SPEC.md` file, no feature directory.
- **Ticket** (`/to-tickets`) → one issue per ticket with `--parent <epic-id>`, which gives
  it a hierarchical id (`bd-a3f8e9.1`, `.2`, …). Type is the author's call: `task`
  (the default) for most slices, `chore` for prefactors, `bug` for defects.
- **Blocking** → native edges. Only the `blocks` type gates readiness; `parent-child`
  deliberately does not, so a ticket is never blocked by its own epic.
- **Priority** is `-p 0..4`, 0 most urgent, default 2.
- **Comments** carry conversation history: `bd comments add <id> "<text>"`.

### Triage roles are labels, with two status side-effects

The five roles in `triage-labels.md` are **labels** (`-l` at create, `--add-label` /
`--remove-label` after), not statuses. `ready-for-agent` and `ready-for-human` would
collapse onto the same status — both are open, unblocked work differing only in who may
take it — so status cannot express the vocabulary. Keeping them as labels also means a
customised right-hand column in `triage-labels.md` works verbatim.

Beads' own statuses (`open`, `in_progress`, `blocked`, `deferred`, `closed`) are a
separate readiness axis: they answer "can this be worked now", where triage answers "has
a maintainer decided what this is". Two roles must move the status as well, or
`bd ready` will offer work nobody can finish:

- `needs-info` → also `bd update <id> --status blocked`
- `wontfix` → also `bd close <id> --reason wontfix`

`needs-triage`, `ready-for-agent` and `ready-for-human` leave the status `open`.

## When a skill says "publish to the issue tracker"

`bd create`. Map the skill's issue template onto native fields rather than markdown
headings:

| Template section         | Beads                                                          |
| ------------------------ | -------------------------------------------------------------- |
| `## Parent`              | `--parent <id>` (omit for a top-level issue)                     |
| `## What to build`       | `-d/--description`                                               |
| `## Acceptance criteria` | `--acceptance "- [ ] …"` (the flag is `--acceptance`)            |
| `## Blocked by`          | omit from the body — carried by the dependency graph             |

Add `--design` only when a prototype produced something prose can't carry precisely
(state machine, schema, type shape).

Publish **in dependency order, blockers first**. Each create prints its id, so a blocker
that already exists can be wired inline with `--deps`:

```
bd create "Extract the payment gateway seam" -t chore -p 1 \
  --parent bd-a3f8e9 -l ready-for-agent \
  -d "<what to build>" --acceptance "- [ ] …" --silent     # prints bd-a3f8e9.1

bd create "Charge a card through the seam" -p 1 \
  --parent bd-a3f8e9 -l ready-for-agent --deps bd-a3f8e9.1 \
  -d "<what to build>" --acceptance "- [ ] …" --silent      # prints bd-a3f8e9.2
```

Read each printed id and paste it literally into the next command. Don't capture it in a
shell variable — each command is its own invocation and shell state does not persist.

`--deps` only expresses "this new issue is blocked by an existing one". When a new issue
must **block** one that already exists, wire it afterwards:

```
bd dep add <blocked-id> <blocker-id>
```

**Sibling order is never implied by `--parent`.** A `parent-child` link blocks children
only when the *parent* is blocked; it says nothing about the order of siblings. Ordering
is always an explicit `blocks` edge.

## When a skill says "fetch the relevant ticket"

```
bd show <id> --json --include-dependents
```

The user normally passes the id; if they pass a title, find it with `bd list --json`.
`bd dep tree <id>` renders the graph; `bd blocked` lists what is stuck.

## Frontier, claim, resolve

The frontier is the open, unblocked, unclaimed work — what can be started right now.
Used by `/implement` to take its next ticket, and by `/wayfinder` to walk a map.

- **Frontier**: `bd ready --unassigned --json`. Scope it to one feature or map with
  `--parent <epic-id>`, and to agent-grabbable work with `--label ready-for-agent`.
  Add `--explain` to see why something is or isn't ready. An empty result means
  everything is either done or blocked — `bd blocked` tells you which.
- **Claim**: `bd update <id> --claim` before any work — one atomic write setting assignee
  and `in_progress`, so a concurrent session cannot take the same ticket. To take the next
  frontier ticket in a single step: `bd ready --parent <epic-id> --claim --json`.
- **Close**: `bd close <id> --reason "<what landed>"`.
- **Discovered work**: `bd create "<title>" --deps discovered-from:<current-id> ...` — a
  non-blocking annotation recording where the work came from, so it doesn't gate anything.

### Wayfinding operations

Used by `/wayfinder`. The **map** is an epic; its tickets are `--parent` children.

- **Map**: `bd create "<effort name>" -t epic -l wayfinder:map -d "<Destination / Notes /
  Decisions so far / Not yet specified / Out of scope body>"`. Both `/to-spec` and
  `/wayfinder` mint epics, so the label — not the type — is what identifies a map.
  Index them with `bd list --label-any wayfinder:map --json`.
- **Child ticket**: `bd create "<question as title>" --parent <map-id>
  -l wayfinder:<type> --no-inherit-labels -d "## Question …"`, where `<type>` is
  `research` / `prototype` / `grilling` / `task`. `--no-inherit-labels` stops
  `wayfinder:map` spreading to every child. Keep the type as a label and leave `-t` at
  its default: beads' type enum collides with wayfinder's only on the word "task", where
  the two mean different things.
- **Blocking**: `bd dep add <blocked-id> <blocker-id>` — the native `blocks` edge, so the
  frontier renders in the tracker's own views.
- **Frontier and claim**: as above, scoped with `--parent <map-id>`. Scoping by parent
  also excludes the map epic itself.
- **Resolve**: `bd comments add <id> "<the answer>"`, then
  `bd close <id> --reason "<one-line gist>"`, then append a context pointer (ticket title,
  its id, and the gist) to the map's Decisions so far. Beads has no append-to-description,
  so that last step is read-modify-write: `bd show <map-id> --json`, edit the body,
  `bd update <map-id> --description "<whole new body>"`. Re-read immediately before
  writing — other sessions edit the map concurrently.
