---
status: accepted
---

# The dashboard and the analysis scripts are removed, and their references deleted

ADR-0001 gave `packages/dashboard` a `Bun.serve` backend that read Runs and
Scenarios straight off disk, and ADR-0002 moved its frontend to a Vite + React
build. The package itself is gone: the workspace has been pruned from
`bun.lock`, and `packages/` now holds only `agent`, `mcp-server`, `runner` and
`shared`. Nothing replaced it. The `analysis/` Python tooling that `DEV_ENV.md`
documented never existed in this repo at all. What survived the code were the
references — `package.json` still defined a `dashboard` script pointing at a
file that was not there, `flake.nix` still carried Python for it and printed its
commands into every new shell, and `DEV_ENV.md` still told a developer to
install and run all of it. This ADR records that the dashboard and the analysis
scripts are not coming back, and that the references to them are deleted.

## Considered Options

- **Build the tooling back rather than delete the references.** Usually the
  honest fix for a stale config is to make what it points at exist. Rejected
  because nothing was asking for it: a Run's data is still fully legible as
  `logs/<runId>/events.jsonl`, and a human reviewing a Run can join the room or
  read the transcript directly.
- **Delete ADR-0001 and ADR-0002 outright**, leaving no trace. Rejected: an ADR
  is a record of a decision, and removing the record leaves a later reader
  unable to tell whether a dashboard was considered and rejected or never
  thought about — which is the same ambiguity that let a stale config mislead
  the first agent to work in this repo.
- **Keep the references and flag them as broken**, so the dashboard is easy to
  revive. Rejected because a dead `bun run` script reads exactly like one that
  should work: it is discovered as a failure at run time, by whoever runs it,
  rather than at the point the decision was made.
- **Leave Python in the devShell** in case analysis returns. Rejected: no
  source file, script or CI job in the repo runs Python, so it was a toolchain
  entry kept alive only by a reference to tooling that does not exist.

## Consequences

- `package.json` loses its `dashboard` script, and `flake.nix` loses
  `python312` and `python312Packages.pip`. The direnv banner and `DEV_ENV.md`
  drop the Python environment and the analysis commands along with them.
- ADR-0001 and ADR-0002 are marked superseded rather than deleted. What they
  decided still holds as background — derived Run status and Scenario linkage
  by `runId` suffix are both in `docs/GLOSSARY.md` — but the package they
  describe is not in the repo.
- `packages/shared/src/runAnalysis.ts` is unaffected: it derives Run status and
  parses `runId` in TypeScript, as part of the runner, and has nothing to do
  with the removed Python tooling.
- Should a dashboard be wanted again it would be a new decision against Runs as
  they are now — one room per Run (ADR-0003), with a derived Run status —
  recorded in a new ADR, not a revival of these two.
