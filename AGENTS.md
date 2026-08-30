# AGENTS.md

Canonical instructions for AI agents working in this repository. `CLAUDE.md` imports this file. A nested `AGENTS.md` in a package directory overrides this one for work inside that package.

## Project

Namzu is an AI agent platform. The monorepo ships:

- `@namzu/sdk` — core runtime (agents, tools, providers, stores, compaction)
- `@namzu/cli` — the operator application
- `@namzu/computer-use`, `@namzu/files`, `@namzu/sandbox` — optional capability packages
- `@namzu/telemetry` — optional observability package
- `@namzu/evals` — the eval suites
- `@namzu/<provider>` — one driver package per service

<dependency_direction>
```
sdk  ←  { cli | computer-use | files | sandbox | telemetry | evals | providers }
```

No circular dependencies. Nothing imports from the same level or above.
</dependency_direction>

> This list previously named `@namzu/contracts`, `@namzu/agents` and
> `@namzu/api`. **None of them exist**, and none appears in `packages/`. A
> routing document is read by every agent before it reads anything else, so a
> package named here is a place someone will look, import from, or reason
> about the layering of — and the layering was stated in terms of two of them.
> Corrected against `packages/` rather than against memory; if this list and
> that directory ever disagree again, the directory is right.

## Build & Test

```bash
pnpm typecheck    # TypeScript across workspace
pnpm lint         # Biome lint + format check
pnpm test         # vitest
pnpm build        # Build all packages
```

Use `pnpm --filter <pkg>` to scope commands to a single package.

<ci_gates>
Those four are a **subset**. The `Build & Test` job in `.github/workflows/ci.yml` runs twenty steps, in this order, and the branch is not green until every one passes.

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
| Public-surface regression check | `node .github/scripts/verify-public-surface.mjs` |
| publint (package.json shape) | `npx -y publint@latest packages/<pkg>` |

Eight of those carry `if: matrix.gates` and so run on one matrix leg only. Locally there is no leg, so run all twenty.

**A direct push to `main` runs a different job.** `ci.yml`'s `Build & Test` is a
pull-request gate; a push straight to `main` is validated inline by
`release.yml` before it publishes. Those two lists had drifted to the point
where fifteen of the gates above applied to branches only, and a documentation
page went stale on `main` inside a commit that reported green. They are now
compared by `check-workflow-gate-parity.mjs`, which fails on any gate present in
one path and not the other unless it is exempted BY NAME with a reason — five
are, all on cost.

A **second job**, `Docs`, runs **two** gates on a full-history checkout:

| Docs step | Run it locally |
|---|---|
| Docs standard gate | `node tools/check-docs.mjs` (= `pnpm docs:check`) |
| Docs fence gate | `pnpm --filter @namzu/sdk build && node tools/check-doc-fences.mjs` |

Full history because the standard gate's drift check compares a document's last commit against its `resource:`'s, which `git log` cannot answer on a shallow clone — it refuses one rather than passing.

The fence gate compiles the ```ts in `docs/` against `packages/sdk/dist`, so this job installs and builds the SDK. Every other gate in this repository checks a document's METADATA; this is the only one that reads its content, and it exists because a rename can otherwise pass everything here while leaving documentation that does not build. Fences opt out by declaring themselves — ```ts sketch is not compiled and is counted out loud, ```ts verbatim is asserted to appear byte-for-byte in the file its `// from:` marker names.

**Why the short list is not enough.** A job stops at its first failing step, and every step after it is reported `skipped`, not `failure`. A red run therefore shows one red entry and a column of grey — and grey is not "these passed", it is "these were never asked". The four commands at the top of this section appear in that table as **Lint**, **Type check**, **Build** and **Test** — rows 1, 3, 4 and 5, since a step that catches a build-graph defect before the compiler reports it as a missing module sits between the first two. Green on them establishes four of the eighteen steps and nothing whatsoever about the other fourteen.
</ci_gates>

## Where to find things

This file is a **router**, not a rulebook. Detail lives in the folders below; read their `README.md` before drilling deeper.

<routing>
  <working_memory path=".work/sessions/">
    Durable agent memory, and **gitignored**. Every non-trivial piece of design, decision, or refactor work opens a session folder here (`ses_<NNN>-<slug>/`). Sessions capture scope, decisions, plans, and open questions. When a new agent takes over, it starts here to see what's in flight.

    It stays untracked on purpose. A session log compares this kernel against other systems by name, and `scripts/audit-external-names.mjs` forbids a third-party product name in tracked prose — so this material can be neither published nor rewritten without destroying what it is for. `.work/parked/` holds superseded analyses of the same kind.

    Skills: `start-session`, `resume-session`, `freeze-session`.
  </working_memory>

  <code_rules path="docs/conventions/">
    Ratified, stable rules about how code is written, and **tracked** — these are live rules, not history. Grows as sessions freeze and emit stable rules. Read its `index.md` for the catalog before a non-trivial change.

    Skill: `read-conventions`.
  </code_rules>

  <published_docs path="docs/">
    User-facing documentation. Pages carry YAML frontmatter the docs gate reads — see the standard below. Do not edit during internal decision work; update only when a design lands and the public surface actually changes.

    Skill: `update-docs`.
  </published_docs>

  <legacy path="(deliberately does not exist)">
    **There is no `docs/legacy/`, and its absence is a decision.** Frozen sessions and superseded design notes stay whole and untracked in `.work/`.

    The plan was to group them under `docs/legacy/`. Measuring them ended it: the owner ruled that no third-party brand name appears in tracked prose, and under that ruling not one frozen session can move without leaving files behind. In every case the blocked files are the `README.md` and the `progress.md` — the ones that give the rest its meaning. Moving the remainder would produce anonymous fragments in a bin, which is the outcome the exercise existed to avoid.

    An empty `docs/legacy/` would be worse than none: a directory that exists to hold the old material, holding nothing, reads as "there is no old material" rather than "the old material could not come". So do not create it. The naming ruling is the owner's to revisit, and this follows from it.
  </legacy>

  <runtime_state path=".namzu/">
    The repo's own dogfooding runtime state (threads, sessions, runs). Do not edit by hand.
  </runtime_state>

  <worktrees path="(agent checkouts — the worktrees directory under the harness config)">
    Path: `.claude/worktrees/<name>`, written here in a code span because the audit forbids that directory's name in bare prose. Most work in this repo now happens in one, and the directory is **gitignored** — a nested checkout committed as a gitlink is not clonable. So a worktree is a whole second copy of the tree carrying its own untracked state, and three things follow that have each cost a diagnosis.

    **`.work/` is per-worktree. It is not shared and it does not travel with the branch.** Being gitignored is exactly why: a freshly added worktree has no `.work/` at all, and each existing one lists a different set of sessions in its own `.work/sessions/README.md`. The `pre-commit` hook resolves that index relative to the current working directory, so it gates on the sessions listed in **this** worktree — a session opened here is invisible to the shared checkout and to every sibling. Open your session where you are working; do not go looking for it elsewhere.

    **A fresh worktree is not a working checkout until `pnpm install && pnpm -r build` has run in it.** Several gates read build output rather than source, and they name the source when they fail. Run `node .github/scripts/check-publish-metadata.mjs` in an unbuilt worktree and it reports, for thirteen of the fourteen publishable packages, that the package "would publish without its `main` (dist/index.js)". That is not a manifest defect: the script packs each package and asserts the declared entry point is in the tarball, and there is no `dist/` yet. The `Evals` gate fails the same way, because it invokes `packages/cli/dist/bin.js`.

    **A lint finding is not evidence your branch caused it.** `pnpm lint` is `pnpm -r lint`, and each package's script is `biome check src/` — the package's whole source tree, never your diff. A worktree branched from an older `origin/main` therefore reports whatever was there at that commit. Check `git diff --name-only origin/main...HEAD` before you accept a hit as yours, and never reformat a file your branch did not change in order to make a gate pass.

    `scripts/audit-external-names.mjs` inventories tracked and non-ignored untracked files, so Git's ignored-worktree rule keeps this second checkout out of a scan from the shared tree. Run the audit from inside your worktree to audit the tree you are actually changing.

    The three above are mechanics — where state lives and what a gate reads. The two below are etiquette, and they are the ones that have actually destroyed work.

    **Never check out a branch in a worktree you did not create.** The protection you would assume exists covers half the case: git refuses the *same* branch in two worktrees, and `git worktree add` on a held branch fails with `already used by worktree at <path>`. Nothing refuses a *different* branch in a directory somebody is working in. The switch carries their uncommitted modified and untracked files across rather than refusing them, so the occupant's work lands in the switcher's tree indistinguishable from their own — one `git add -A` from a commit on the wrong branch. A `git checkout` inside a script or a mutation harness does the same thing without anyone deciding to. If you need another branch, create your own directory.

    **Stage explicit paths. Never `git add -A` or `git add .`.** This is what makes sharing a directory survivable when the rule above is broken, and it is the only one of these two that does not depend on anyone else behaving. Name the files you changed. Run `git status` when you enter a tree and treat anything already dirty as somebody else's until you know otherwise.

    **Assume anything uncommitted can vanish, and commit early.** A commit is in the object database every worktree shares, so a branch survives another agent switching, removing or reverting inside your directory. Uncommitted work is the only kind that has ever been lost here. Write the `progress.md` entry the hook needs, then commit as soon as a change is coherent, rather than holding a large one in a working tree or parking it in a patch file.
  </worktrees>
</routing>

## Documentation standard

`docs/` follows the estate documentation standard: markdown with YAML front matter, one concept per file, Diataxis content types. Required keys, all machine-checked by `pnpm docs:check` (`tools/check-docs.mjs`):

`uid`, `title`, `description` (75-300 chars), `type`, `diataxis`, `owner`, `status`, `timestamp`, `lastReviewed`.

`type` is what kind of thing the document is; `diataxis` is how it is written. They are separate on purpose — collapsing them would restate one fact in two fields.

Optional and load-bearing: `resource:` names the code the document describes, and the gate **fails the build** when that code has commits newer than the document. `verified:` records who last re-established the document against source; **omit it rather than guess**, because an absent key honestly reads as unverified and a false one does not.

The gate is authoritative only inside the directories listed in its `CONFORMING` array and prints the unmigrated remainder on every run. Add a directory there in the same change that brings its pages up to the standard, never before.

## Working flow

<flow>
1. Starting or continuing any non-trivial work → open or resume a session.
2. Before a non-trivial change → read the relevant conventions.
3. After drafting a plan → run an adversarial second-opinion check (see `codex-check` skill).
4. **Every commit while an in-progress session exists** → `progress.md` entry is written **synchronously with the commit**, not as a follow-up. `.work/` is gitignored, so the entry does not enter the commit itself — it lives on local disk, and the discipline is that the working-tree update happens before `git commit` runs. This is non-negotiable — the log is what makes a fresh agent able to pick up after `/clear`, and a six-commit gap has happened before. An entry is one line minimum: `- <hash> <subject> — what/why` (hash filled post-commit); add a `**Deviation:**` line if the commit diverges from the ratified plan. See skill: `commit`.
5. After implementation → `pnpm typecheck && pnpm lint && pnpm test` must all pass. That trio is three of the seventeen steps CI runs, not the gate — before pushing, work the `<ci_gates>` table under **Build & Test**.
6. Commit touches public surface (exported types, wire schema, CLI flags, API routes)? → **queue a `**Docs debt:**` line in the touching commit's `progress.md` entry**; the debt is cleared by running the `update-docs` skill before `freeze-session`. Queuing is mandatory per commit; actually writing `docs/` pages can batch at freeze time.
7. Decisions turning final → freeze the session; extract stable rules into `docs/conventions/`, written to the documentation standard above.
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

**A version PR is a snapshot, and merging a stale one spends a version number on nothing.** Before merging `chore(release): version packages`, every changeset file present on `main` must appear in that PR's deleted files. One missing means the PR was computed before that changeset landed; merge it and the publish step sees pending changesets, opens a fresh version PR instead of publishing, and the bump it already wrote to the CHANGELOG reaches no registry. Its existence is not evidence of its currency — check what it consumes.

**A green release run is not a publish, and a version number is not the fix.** Confirming a release means asking the registry, and picking the right run to watch in the first place. Both procedures, with the commands, are in skill: `release` (Phase 2, steps 4 and 6).
</releases>

<workflow_safety>
- Never push without explicit user approval.
- Never run destructive ops (`git reset --hard`, `git push --force`, `rm -rf`, `npm unpublish`) without explicit approval.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks. The husky `pre-commit` hook (`.husky/pre-commit`) machine-enforces the per-commit progress gate: every active session in `.work/sessions/README.md` must have a `progress.md` mtime newer than the staged files. Bypass with `--no-verify` is forbidden by this rule, not by the hook itself.
- File-scoped operations (lint, unit tests) may run freely. Risky operations (installs, pushes, infrastructure changes) require approval.
- Never check out a branch in a worktree you did not create, and never `git add -A`. Both are about sharing a machine with other agents; the reasoning is in `<worktrees>` above rather than twice.
</workflow_safety>

## Second-opinion loop

Non-trivial plans are cross-checked with an adversarial second agent. Prompt for attack, not approval — "find what's broken" rather than "does this work?". See skill: `codex-check`.
