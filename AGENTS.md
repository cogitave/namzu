# AGENTS.md

Canonical instructions for AI agents working in this repository. `CLAUDE.md` imports this file. A nested `AGENTS.md` in a package directory overrides this one for work inside that package.

## Project

Namzu is an AI agent platform. The monorepo ships:

- `@namzu/contracts` — leaf types and wire schemas (no workspace imports)
- `@namzu/sdk` — core runtime (agents, tools, providers, stores, compaction)
- `@namzu/agents`, `@namzu/api`, `@namzu/cli` — applications
- `@namzu/computer-use` — optional subprocess capability package
- `@namzu/<provider>` — OpenAI, Anthropic, Bedrock, OpenRouter, HTTP, Ollama, LM Studio

<dependency_direction>
```
contracts  ←  sdk  ←  { agents | api | cli | computer-use | providers }
```

No circular dependencies. Nothing imports from the same level or above.
</dependency_direction>

## Build & Test

```bash
pnpm typecheck    # TypeScript across workspace
pnpm lint         # Biome lint + format check
pnpm test         # vitest
pnpm build        # Build all packages
```

Use `pnpm --filter <pkg>` to scope commands to a single package.

## Where to find things

This file is a **router**, not a rulebook. Detail lives in the folders below; read their `README.md` before drilling deeper.

<routing>
  <working_memory path="docs.local/sessions/">
    Durable agent memory. Every non-trivial piece of design, decision, or refactor work opens a session folder here (`ses_<NNN>-<slug>/`). Sessions capture scope, decisions, plans, and open questions. When a new agent takes over, it starts here to see what's in flight.

    Skills: `start-session`, `resume-session`, `freeze-session`.
  </working_memory>

  <code_rules path="docs.local/conventions/">
    Ratified, stable rules about how code is written. Grows organically as sessions freeze and emit stable rules. Read its `README.md` for the catalog before a non-trivial change.

    Skill: `read-conventions`.
  </code_rules>

  <published_docs path="docs/">
    User-facing documentation published to `docs.namzu.ai`. Pages carry YAML frontmatter (`related_packages`, `surface`, `status`, `last_updated`) so the right page can be found from a code change. Do not edit during internal decision work; update only when a design lands and the public surface actually changes.

    Skill: `update-docs`.
  </published_docs>

  <runtime_state path=".namzu/">
    The repo's own dogfooding runtime state (threads, sessions, runs). Do not edit by hand.
  </runtime_state>
</routing>

## Working flow

<flow>
1. Starting or continuing any non-trivial work → open or resume a session.
2. Before a non-trivial change → read the relevant conventions.
3. After drafting a plan → run an adversarial second-opinion check (see `codex-check` skill).
4. **Every commit while an in-progress session exists** → `progress.md` entry is written **synchronously with the commit**, not as a follow-up. `docs.local/` is gitignored, so the entry does not enter the commit itself — it lives on local disk, and the discipline is that the working-tree update happens before `git commit` runs. This is non-negotiable — the log is what makes a fresh agent able to pick up after `/clear`, and a six-commit gap has happened before. An entry is one line minimum: `- <hash> <subject> — what/why` (hash filled post-commit); add a `**Deviation:**` line if the commit diverges from the ratified plan. See skill: `commit`.
5. After implementation → `pnpm typecheck && pnpm lint && pnpm test` must all pass.
6. Commit touches public surface (exported types, wire schema, CLI flags, API routes)? → **queue a `**Docs debt:**` line in the touching commit's `progress.md` entry**; the debt is cleared by running the `update-docs` skill before `freeze-session`. Queuing is mandatory per commit; actually writing `docs/` pages can batch at freeze time.
7. Decisions turning final → freeze the session; extract stable rules into `conventions/`.
</flow>

## Hard rules

<git_identity>
Required author: `bahadirarda <bahadirarda@users.noreply.github.com>`. Verify `git config --show-origin user.email` before any commit. Identity contamination has previously required filter-branch remediation. See skill: `commit`.
</git_identity>

<commit_format>
Conventional Commits. No AI co-author trailers. See skill: `commit`.
</commit_format>

<releases>
Git tags with per-package prefixes drive releases (`sdk-v*`, `computer-use-v*`, etc.). Never hand-edit `package.json#version`; use the per-package `release:*` scripts. See skill: `release`.
</releases>

<workflow_safety>
- Never push without explicit user approval.
- Never run destructive ops (`git reset --hard`, `git push --force`, `rm -rf`, `npm unpublish`) without explicit approval.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- File-scoped operations (lint, unit tests) may run freely. Risky operations (installs, pushes, infrastructure changes) require approval.
</workflow_safety>

## Second-opinion loop

Non-trivial plans are cross-checked with an adversarial second agent. Prompt for attack, not approval — "find what's broken" rather than "does this work?". See skill: `codex-check`.
