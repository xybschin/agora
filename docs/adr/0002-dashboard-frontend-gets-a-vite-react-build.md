# Dashboard frontend moves to React + shadcn/ui via a Vite build step

> **Superseded in full** by
> `docs/adr/0004-dashboard-and-analysis-tooling-removed.md`: the
> `packages/dashboard` package described below was removed from the repo, and
> with it the `analysis/` scripts. Kept as a historical record — nothing
> below describes the repo today.

Supersedes ADR-0001's "no build step" decision for the frontend half of the
dashboard. The backend half of that decision — `Bun.serve` reading Runs and
Scenarios directly off disk, no database, no live-tail — is unchanged; see
`docs/adr/0001-dashboard-reads-logs-and-scenarios-directly.md`, whose
consequences section still holds.

We migrated `packages/dashboard`'s frontend from hand-written HTML/CSS/JS
(`public/index.html`, `public/app.js`, `public/style.css`) to React with
shadcn/ui components, built by Vite. This reintroduces the build step
ADR-0001 explicitly rejected, because a component library and JSX can't be
served as-is — Vite compiles `packages/dashboard/web/**` to
`packages/dashboard/dist/`, which `src/server.ts` now serves as static
files instead of the old fixed `STATIC_FILES` map.

We kept the backend surface identical: same `/api/runs` and
`/api/runs/:id/transcript` endpoints, same response shapes
(`RunSummary`/`RunListError`/`TranscriptEntry` in `src/runs.ts` and
`src/transcript.ts`), same status/linkage derivation ADR-0001 describes.
Only the rendering layer changed.

## Consequences

- **A build step is now required before `bun run start` serves current
  content**: `bun run build` (Vite) must run first, or `dist/` is stale.
  `bun run dev` runs the Vite dev server directly (with `/api` proxied to
  the Bun backend on port 4100) for iteration without rebuilding.
- **New dependencies**: React, Vite, Tailwind CSS v4, and shadcn/ui's
  generated components (`web/components/ui/`) plus their peers
  (`radix-ui`, `class-variance-authority`, `cn`). This is more surface
  area than the zero-dependency frontend ADR-0001 described, traded for
  faster iteration on dashboard UI as it grows past a single static page.
- **`packages/dashboard/tsconfig.web.json`** typechecks `web/**` with DOM
  libs and the `@/*` path alias separately from `tsconfig.json`, which
  still typechecks only the Bun backend in `src/**`. `bun run typecheck`
  runs both.
- **No change to Run/Scenario semantics**: this ADR only touches how the
  dashboard renders data it already had; nothing here affects Run status
  derivation, Scenario linkage, or the no-live-tail decision.
