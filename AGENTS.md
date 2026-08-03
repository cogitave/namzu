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
Releases are driven by [Changesets](https://github.com/changesets/changesets). Every PR that touches a publishable package adds a `.changeset/<slug>.md` declaring bump intent; on merge to `main`, `changesets/action@v1` opens a "chore(release): version packages" PR; merging that PR publishes every bumped package to npm via `pnpm changeset publish` under `.github/workflows/release.yml`. Never hand-edit `package.json#version` or invoke `npm publish` directly. See skill: `release`.

**Bump intent is a claim about the consumer, not about effort.** [SemVer rule 8](https://semver.org/) admits no exception: `major` for *any* backward-incompatible change to the public API — a removed or renamed export, a narrowed union, a changed default, a widened peer range. Rewriting the whole kernel without touching the public surface is `patch`.

**Deprecate before you remove.** SemVer's own guidance is that a removal should be preceded by at least one minor release carrying the deprecation, so a consumer has a version where their code still compiles and warns. Applied here:

- **Renaming** an exported identifier or a union member ⇒ ship the new name plus the old one marked `@deprecated` in a `minor`, and remove the old name in a later `major`. A rename with no alias is the case this rule exists for.
- **Removing** a declaration that provably does nothing — no producer, no reader, no runtime effect — may go straight to `major`. A deprecation window exists so working code can migrate, and there is no working code to migrate off a field that was never read. Say so in the changeset.
- **Changing a default** ⇒ `major`, and the changeset names the value that changed and what a caller does to keep the old behaviour.

A changeset body is read by a stranger deciding whether to take the upgrade. Name what breaks and what to do about it, not what the work was.
</releases>

<workflow_safety>
- Never push without explicit user approval.
- Never run destructive ops (`git reset --hard`, `git push --force`, `rm -rf`, `npm unpublish`) without explicit approval.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks. The husky `pre-commit` hook (`.husky/pre-commit`) machine-enforces the per-commit progress gate: every active session in `docs.local/sessions/README.md` must have a `progress.md` mtime newer than the staged files. Bypass with `--no-verify` is forbidden by this rule, not by the hook itself.
- File-scoped operations (lint, unit tests) may run freely. Risky operations (installs, pushes, infrastructure changes) require approval.
</workflow_safety>

## Second-opinion loop

Non-trivial plans are cross-checked with an adversarial second agent. Prompt for attack, not approval — "find what's broken" rather than "does this work?". See skill: `codex-check`.
