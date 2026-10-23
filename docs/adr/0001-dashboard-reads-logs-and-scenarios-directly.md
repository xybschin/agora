# Dashboard reads Runs and Scenarios directly off disk, no persistence layer

> **Superseded in full** by
> `docs/adr/0004-dashboard-and-analysis-tooling-removed.md`: the
> `packages/dashboard` package described below was removed from the repo, and
> with it the `analysis/` scripts. Kept as a historical record — nothing
> below describes the repo today.

> **Partially superseded** by
> `docs/adr/0002-dashboard-frontend-gets-a-vite-react-build.md`: the "no
> build step" clause below applied to the frontend, which now builds via
> Vite. Everything else here — the `Bun.serve` backend, no database, no
> live-tail, and the Consequences section — still holds.

We need a local dashboard (`packages/dashboard`) to browse Scenario Runs and
review their Transcripts. Runs already live as facts on disk — a
`logs/<runId>/events.jsonl` transcript per Run, plus the originating
`scenarios/<name>.yaml`. We decided the dashboard reads both directly at
request time (a `Bun.serve` backend, no build step, no database, no
live-tail of in-progress Runs) rather than introducing a store that indexes
or caches Run metadata.

We considered adding a lightweight index (e.g. a JSON or SQLite file the
runner writes per Run) to avoid recomputing status/linkage on every
request, but rejected it: Run volume is low (local research harness, not a
production system), and a second source of truth for data that's fully
recoverable from `events.jsonl` risks drifting out of sync with the logs it
describes.

## Consequences

- **Run status is derived, not stored** (see `docs/GLOSSARY.md` — *Run
  status*): the runner never writes a "completed" event on success, only
  `run_aborted` on failure (`packages/runner/src/index.ts:80-91`), so the
  dashboard must infer completed/aborted/incomplete from the transcript's
  tail every time it lists Runs. It does this from the highest tick number
  seen across *any* event, not from a tick-boundary event —
  `tick_start`/`tick_end` are declared in `AgoraEvent` but nothing emits
  them; verified against this repo's real logs, which only ever contain
  `stance`/`usage`/`message` events.
- **Scenario linkage is a naming convention, not a stored reference**: a
  Run's Scenario is recovered by stripping the trailing `-<timestamp>` off
  its `runId` (matching `sanitize(\`${scenario.name}-${Date.now()}\`)` in
  `packages/runner/src/index.ts:43`) and loading
  `scenarios/<name>.yaml`. If a Scenario is ever renamed or deleted after a
  Run exists, that Run's persona/topic lookup breaks — acceptable for now,
  but worth revisiting if Scenarios stop being append-only.
- No live view of a Run in progress: acceptable because the runner tears
  down a Run's containers immediately after it finishes
  (`packages/runner/src/index.ts:96-98`), so there's only a narrow window
  where "live" would even mean something.
