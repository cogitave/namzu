# AGENTS.md

Canonical agent/AI-tool instructions for the Namzu monorepo. `CLAUDE.md` imports this file.

## Project

Namzu — an AI agent platform with SDK, runtime, connectors, and multi-tenant support.

Monorepo: `packages/namzu-{contracts,sdk,agents,api,cli}`.

## Documentation Hierarchy

Authoritative source of truth for HOW code is written:

```
docs.local/
├── CONVENTIONS.md                          — Lean rules (one paragraph per subsection) + pointers
├── CHECKLIST.md                            — Verification items matching CONVENTIONS sections
└── architecture/
    ├── patterns/namzu-sdk/*.md             — Detailed pattern docs (folder trees, hierarchies, examples)
    └── refactoring/*.md                    — Per-issue trackers for architectural fixes

docs/
└── architecture/decisions/adr-*.md         — ADRs for convention deviations / cross-cutting choices
```

**Rule:** `CONVENTIONS.md` holds the one-paragraph rule + a pointer. `patterns/` holds the detail (folder trees, tables, examples, migrations). Never duplicate content across the two — detail in pattern docs, summary in CONVENTIONS.

## Convention Model

Each convention uses a two-tier structure:

- **📐 Generic Rule** — technology-agnostic best practice, transferable to any project.
- **🔧 Project Implementation** — how this specific project implements the rule.

## Working Flow

Before any non-trivial change:

1. Read `docs.local/CONVENTIONS.md` for applicable rules.
2. Follow the pointer to the owning pattern doc in `docs.local/architecture/patterns/` for detail.
3. If adopting a pattern from an external project → follow `docs.local/architecture/patterns/reference-pattern.md`.
4. Cross-check plans with a second agent (Codex via `codex:codex-rescue`) on non-trivial work — **prompt Codex adversarially**. Don't ask "does this work?" — ask "find what's broken in this plan / what edges does it miss / what would break this implementation / where does it drift from convention?". Codex's value is in push-back, not confirmation. Surface blockers explicitly; ignore generic praise.

After implementation:

1. Run `docs.local/CHECKLIST.md` to verify compliance.
2. `pnpm typecheck` + `pnpm lint` + `pnpm test` must all pass.
3. For per-issue architectural fixes, create a tracker in `docs.local/architecture/refactoring/NNN-<slug>.md`.

## Deviating From a Convention

When a change contradicts a written convention or pattern rule:

1. Write an ADR at `docs/architecture/decisions/adr-<slug>.md` explaining the decision.
2. Update the relevant pattern doc first (owns the detail).
3. Update `CONVENTIONS.md`'s rule summary to match.
4. Commit code + doc changes together.

Do NOT change code first and align docs later. Do NOT act on `CONVENTIONS.md` alone for pattern-sensitive work — the pattern doc is more specific and usually the authority.

## Key Conventions (Quick Reference)

| # | Convention | Type |
|---|-----------|------|
| 0 | Design Principles (no workarounds, fix at root cause) | 📐 + 🔧 |
| 1 | Naming (files, identifiers, boundaries) | 📐 + 🔧 |
| 2 | Branded IDs (type-safe resource identifiers) | 📐 + 🔧 |
| 3 | Generic type parameters (`TInput`, `TOutput`, etc.) | 📐 |
| 4 | Import/export (barrels, ESM, dependency direction) | 📐 + 🔧 |
| 5 | Error handling (deny-by-default, fail fast) | 📐 + 🔧 |
| 6 | Exhaustiveness (never assertions on unions) | 📐 + 🔧 |
| 7 | Configuration (centralized schema, 12-factor, BYOK) | 📐 + 🔧 |
| 8 | Atomic writes (write-tmp-rename) | 📐 + 🔧 |
| 9 | Registry + Manager + Store + Run + Bridge patterns | 📐 + 🔧 |
| 10 | Provider abstraction (interface in types/, impl in providers/) | 📐 + 🔧 |
| 11 | Tool definition (`defineTool()`) | 📐 |
| 12 | Persona system (YAML, inheritance) | 📐 + 🔧 |
| 13 | ADR format | 📐 |
| 14 | Documentation format | 📐 |
| 15 | API conventions (envelope, pagination, errors) | 📐 + 🔧 |
| 16 | Event emission (typed, discriminated unions) | 📐 |
| 17 | Multi-tenant isolation | 📐 |
| 18 | Logging (structured, no console.log) | 📐 |
| 19 | Version string (single constant) | 📐 + 🔧 |
| 20 | Constants (centralized, domain-grouped) | 📐 + 🔧 |
| 21 | Commit convention (Conventional Commits) | 📐 + 🔧 |

## Barrel Pattern (Convention #4 specifics)

- Every multi-symbol feature folder has an `index.ts` barrel that re-exports its public API.
- Root `src/index.ts` imports through sub-barrels (e.g. `./registry/index.js`), NEVER directly from concrete files (`./registry/tool/execute.js`).
- Single-file features may skip the sub-barrel (no indirection benefit).
- External consumers import from `@namzu/sdk` only; `package.json#exports` gates sub-path access.
- When adding a new class: export from concrete file → re-export from sub-barrel → re-export from root barrel.

## Release Flow (Convention #19.2)

- Git tag is the canonical release signal. **Never hand-edit `package.json`.**
- Monorepo publishes multiple packages via **tag prefixes**:
  - `sdk-v*` → `@namzu/sdk` (workflow: `.github/workflows/release-sdk.yml`)
  - `computer-use-v*` → `@namzu/computer-use` (workflow: `.github/workflows/release-computer-use.yml`)
- Run the per-package script from the package dir (or via pnpm filter):
  - `pnpm --filter @namzu/sdk release:rc` / `release:patch` / `release:minor` / `release:major` / `release:stable` / `release:beta`
  - `pnpm --filter @namzu/computer-use release:rc` / `release:patch` / …
- The script bumps version, commits, tags with the correct prefix, and pushes. The matching GitHub Action publishes to npm with the right dist-tag based on the version string (`*-rc.*` → rc, plain semver → latest, etc.).
- Workflow files in `.github/workflows/release-*.yml` are the authority. Don't publish to npm manually.
- NPM Trusted Publisher is configured for both packages — no NPM_TOKEN involved.

## Git Identity

- Required: `bahadirarda <bahadirarda@users.noreply.github.com>`
- Verify at session start if committing is anticipated: `git config --show-origin user.email`
- If global config shows any non-bahadirarda value (e.g. stale `caucasian01` from GitHub Desktop), set the local override BEFORE committing. Contamination happened once (rc.1) and required filter-branch + force-push remediation.
- **No AI co-authors in commits.** Convention #21 forbids `Co-Authored-By: Claude ...` trailers.

## Workflow Safety

- **Never push to remote without explicit user approval.** Always show what will be pushed first.
- **Never run destructive ops** (`git reset --hard`, `git push --force`, `rm -rf`, `npm unpublish`) without explicit approval.
- **Always update `docs.local/`** alongside code when introducing conventions, patterns, or checklist items.

## Package Dependency Direction

```
@namzu/contracts  (leaf — no workspace imports)
       ↑
@namzu/sdk        (core — imports only contracts)
       ↑
@namzu/agents | @namzu/api | @namzu/cli | @namzu/computer-use  (apps + capability packages)
```

No circular deps. No package imports from the same level or above.

`@namzu/computer-use` is an optional capability package — a subprocess-based
`ComputerUseHost` implementation for the contract shipped by `@namzu/sdk`. It
follows the same dep direction as apps (imports from sdk, never imported by it).
Released independently on tag prefix `computer-use-v*` (see Release Flow).

## Build Commands

```bash
pnpm typecheck    # TypeScript type check across workspace
pnpm lint         # Biome lint + format check
pnpm test         # vitest
pnpm build        # Build all packages
```
