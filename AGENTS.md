# AGENTS.md

Canonical instructions for AI agents working in this repository. `CLAUDE.md` imports this file. A nested `AGENTS.md` in a package directory overrides this one for work inside that package.

## Project

Namzu is an AI agent platform. The monorepo ships:

- `@namzu/sdk` — core runtime (agents, tools, providers, stores, compaction)
- `@namzu/cli` — the operator application
- `@namzu/computer-use`, `@namzu/files`, `@namzu/live`, `@namzu/lsp`, `@namzu/sandbox` — optional capability packages
- `@namzu/telemetry` — optional observability package
- `@namzu/evals` — the eval suites
- `@namzu/<provider>` — one driver package per service

<dependency_direction>
```
sdk  ←  { computer-use | live | lsp | sandbox | telemetry | evals | providers }
{ sdk | computer-use | files | selected providers }  ←  cli
files  (standalone)
```

No circular dependencies. Leaf packages do not import one another; the CLI is
the composition root and may import the leaves it ships with. No package
imports the CLI. If this list and `packages/` ever disagree, the directory is
right.
</dependency_direction>

## Build & Test

```bash
pnpm typecheck    # TypeScript across workspace
pnpm lint         # Biome lint + format check
pnpm test         # vitest
pnpm build        # Build all packages
```

Use `pnpm --filter <pkg>` to scope commands to a single package. SDK tests run
through `pnpm --filter @namzu/sdk test -- <file>`, never bare `vitest`.

<ci_gates>
Those four are a **subset**. The `Build & Test` job in `.github/workflows/ci.yml` runs the steps below, in this order, and the branch is not green until every one passes.

| CI step | Run it locally |
|---|---|
| Lint | `pnpm lint` |
| The two paths onto main run the same gates | `node .github/scripts/check-workflow-gate-parity.mjs` |
| Project references match workspace dependencies | `node .github/scripts/check-project-references.mjs` |
| Type check | `pnpm typecheck` |
| Build | `pnpm -r build` |
| Test | `pnpm -r test` |
| Process-level regression tests | `pnpm --filter @namzu/sdk test:proc` |
| External-name audit | `node --import tsx --test scripts/__tests__/audit-external-names.test.ts && node scripts/audit-external-names.mjs` |
| Log standard gate | `node --import tsx --test scripts/__tests__/check-log-standard.test.ts && node scripts/check-log-standard.mjs` |
| Model price catalogue matches its source | `node scripts/generate-model-prices.mjs --check` |
| Installer parses as POSIX sh | `sh -n install.sh && dash -n install.sh` |
| Evals | `node packages/cli/dist/bin.js eval --dir packages/evals --out eval-report.json` |
| SDK coverage (produce summary) | `pnpm --filter @namzu/sdk test:coverage` |
| SDK coverage floor gate | `node .github/scripts/check-sdk-module-coverage.mjs` |
| SDK test-presence gate | `node .github/scripts/check-sdk-test-presence.mjs` |
| Publish-metadata gate | `node .github/scripts/check-publish-metadata.mjs` |
| Pre-publish consumer install check | `bash .github/scripts/verify-consumer-install.sh` |
| Signature types are exported | `node .github/scripts/check-signature-types-exported.mjs` |
| publint (package.json shape) | `npx -y publint@latest packages/<pkg>` |

Some carry `if: matrix.gates` and so run on one matrix leg only. Locally there is no leg, so run them all.

A **direct push to `main` runs a different job**: `release.yml` validates inline before it publishes. `check-workflow-gate-parity.mjs` fails on any gate present in one path and not the other unless it is exempted by name with a reason.

A **second job**, `Docs`, runs two gates:

| Docs step | Run it locally |
|---|---|
| Docs OKF gate | `pnpm docs:check` (`tools/check-docs-okf.mjs` and its test) |
| Docs fence gate | `pnpm -r build && node tools/check-doc-fences.mjs` |

The fence gate compiles the ```ts in `docs/` and the package READMEs against the built packages. A fence opts out by declaring itself: ```ts sketch is not compiled and is counted out loud; ```ts verbatim is asserted to appear byte-for-byte in the file its `// from:` marker names.

**Why the short list is not enough.** A job stops at its first failing step, and every step after it is reported `skipped`, not `failure`. Green on lint, typecheck, build and test establishes four steps and nothing about the rest.

**A worktree is not a working checkout until `pnpm install && pnpm -r build` has run in it.** Several gates read build output, and they name the source when they fail. `pnpm lint` checks each package's whole source tree, never your diff: check `git diff --name-only origin/main...HEAD` before you accept a hit as yours.
</ci_gates>

## Documentation

`docs/` is an [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) knowledge bundle, and `pnpm docs:check` enforces exactly the spec's conformance rules:

- Every page other than `index.md` and `log.md` is a **concept**: YAML frontmatter with a non-empty `type`. Recommended: `title`, `description`, `resource` (the code the page describes), `tags`.
- `docs/index.md` carries only `okf_version: "0.2"`. Every other `index.md` carries no frontmatter and lists its directory as `* [Title](file.md) - description`. Add a page to its directory's index when you add the page.
- `docs/log.md` is the update history, newest date first, `## YYYY-MM-DD` headings, one bullet per change with a leading bold word (`**Creation**`, `**Update**`, `**Deprecation**`). Write the entry in the same commit as the change.
- Trust is frontmatter, not prose. `generated: { by, at }` says who produced the content and when; `verified: [{ by, at }]` says who confirmed it against its sources. Actors are `human:<id>`, `process:<id>`, or `<producer>/<version>`. Omit `verified` rather than guess it: absent reads honestly as unverified.
- `status` is `draft`, `stable` (the default) or `deprecated`. Set `stale_after` when a page has a known expiry.

A change to a public surface (an exported symbol, a CLI flag, a config key, a wire shape) updates the page that describes it in the same commit, or creates one. Documentation that describes code which no longer exists is a defect, not a backlog.

## Working flow

1. Read the neighbouring code and the page in `docs/` that describes it before a non-trivial change. `docs/conventions/` holds the rules this repository has ratified, each with the incident behind it.
2. After implementation: `pnpm typecheck && pnpm lint && pnpm test`, then the rest of the `<ci_gates>` table before pushing.
3. A change to a publishable package adds a `.changeset/<slug>.md`. A change to a public surface updates `docs/` and `docs/log.md`.
4. Commit when a change is coherent. Uncommitted work is the only kind that has ever been lost here.

## Hard rules

<git_identity>
Required author: `bahadirarda <bahadirarda@users.noreply.github.com>`. Verify `git config --show-origin user.email` before any commit. Identity contamination has previously required filter-branch remediation.
</git_identity>

<commit_format>
Conventional Commits: `<type>(<scope>): <subject>`, types `feat|fix|refactor|docs|test|chore|build|ci|perf`, scope the package or area. No AI co-author trailers.
</commit_format>

<releases>
Releases are driven by [Changesets](https://github.com/changesets/changesets). Every PR that touches a publishable package adds a `.changeset/<slug>.md` declaring bump intent; on merge to `main`, `changesets/action@v1` opens a "chore(release): version packages" PR; merging that PR publishes every bumped package to npm via `pnpm changeset publish` under `.github/workflows/release.yml`. Never hand-edit `package.json#version` or invoke `npm publish` directly.

**Bump intent is a claim about the consumer, not about effort.** [SemVer rule 8](https://semver.org/) admits no exception: `major` for *any* backward-incompatible change to the public API — a removed or renamed export, a narrowed union, a changed default, a widened peer range. Rewriting the whole kernel without touching the public surface is `patch`.

**Deprecate before you remove.** Renaming an exported identifier ⇒ ship the new name plus the old one marked `@deprecated` in a `minor`, remove the old name in a later `major`. Removing a declaration that provably does nothing may go straight to `major`; say so in the changeset. Changing a default ⇒ `major`, naming the value that changed and what a caller does to keep the old behaviour.

A changeset body is read by a stranger deciding whether to take the upgrade. Name what breaks and what to do about it, not what the work was.

**A version PR is a snapshot.** Before merging `chore(release): version packages`, every changeset file present on `main` must appear in that PR's deleted files; otherwise the publish step sees pending changesets and opens a fresh version PR instead of publishing.

**A green release run is not a publish.** Confirming a release means asking the registry: `npm view <pkg> version`.
</releases>

<workflow_safety>
- Never push without explicit user approval. Approval for one push does not extend to the next.
- Never run destructive ops (`git reset --hard`, `git push --force`, `rm -rf`, `npm unpublish`) without explicit approval.
- Never skip hooks or checks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- File-scoped operations (lint, unit tests) may run freely. Risky operations (installs, pushes, infrastructure changes) require approval.
- Stage explicit paths. Never `git add -A` or `git add .`.
- Never check out a branch in a worktree you did not create; git carries the occupant's uncommitted files across the switch. If you need another branch, create your own directory.
</workflow_safety>
