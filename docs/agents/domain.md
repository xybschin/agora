# Domain Docs
How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Current state

Both exist:

- `docs/CONTEXT.md` — the domain glossary
- `docs/adr/` — architectural decision records, numbered `NNNN-slug.md`

`/domain-modeling` adds a term or a decision when one actually gets resolved, so
both grow over time. Don't create them upfront.

## Read

- `docs/CONTEXT.md` for the domain glossary relevant to the area you're working in
- Any ADRs in `docs/adr/` that touch that area

## Use the glossary's vocabulary
When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `docs/CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts
If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
