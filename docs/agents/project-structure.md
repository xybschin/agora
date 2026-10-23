# Project Structure

The index the engineering skills use to locate this repo's shared skill config.
Your agent reads this because `AGENTS.md` (auto-loaded into every
run) points its `## Agent skills` block here. Start here, then follow the links
below for the details you need.

## Docs root

The documentation root for this repo is `docs/`. All shared skill config
lives under `docs/agents/`.

## Index

- **Domain docs** — the glossary at `docs/GLOSSARY.md` and the ADRs at `docs/adr/` (`NNNN-slug.md`) both exist; read them before exploring.
  See [domain.md](./domain.md).
- **Issue tracker** — GitHub issues in the repo's own `agora` repo, read and written
  via the `gh` CLI. See [issue-tracker.md](./issue-tracker.md).
- **Triage labels** — canonical role names used as-is (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix).
  See [triage-labels.md](./triage-labels.md).

Each bullet names the **destination** file in `docs/agents/`, not the
seed template it was generated from. Keep the one-line summaries current so an
agent reading only this index gets the gist without opening every file.
