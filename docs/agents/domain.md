# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Monorepo (pnpm workspaces), single context (one `CONTEXT.md` at the repo root):

```
/
├── AGENTS.md
├── CONTEXT.md
├── content/                      # game content (JSON); schema drafts in schemas/
├── docs/
│   ├── adr/                      # decision records
│   ├── agents/                   # agent pipeline conventions
│   └── research/                 # research notes
├── schemas/                      # content JSON Schema drafts
├── apps/                         # applications
│   ├── web/                      # game frontend
│   └── editor/                   # content editor (dev-time)
└── packages/                     # libraries (engine `core` planned here)
```

**Path conventions**: applications live in `apps/<name>/`, libraries in `packages/<name>/`; cross-package imports use `workspace:*`; relative paths always resolve from the repo root (`apps/`, `packages/`, `content/`) — there is no top-level `src/`. A multi-context repo would keep one `CONTEXT.md` per package plus a root `CONTEXT-MAP.md`, with context-scoped ADRs under `docs/adr/` inside each package.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
