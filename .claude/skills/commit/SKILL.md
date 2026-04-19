---
name: commit
description: Use this skill whenever code or documentation changes are about to be committed to git. Triggers include "commit this", "save progress", completion of a feature or fix, or recognition that uncommitted changes should land as a logical unit. Always use before running `git commit` on this repository — the git identity check and Conventional Commits contract here are strict, and past identity contamination has required force-push remediation.
---

# Commit

Prepares and creates a git commit on this repository with the correct author identity and a Conventional Commits message. AI co-author trailers are forbidden.

## When to trigger

<triggers>
- Changes are staged or ready to stage and the user wants to commit.
- A session's implementation phase produces a clean working unit that should land as one commit.
- After a successful release bump (the release script itself commits, but follow-up commits around a release still use this skill).
</triggers>

## Steps

<procedure>
1. Verify git identity BEFORE staging anything:

   ```bash
   git config --show-origin user.email
   git config --show-origin user.name
   ```

   Required values:
   - `user.email` → `bahadirarda@users.noreply.github.com`
   - `user.name` → `bahadirarda`

   If either global value is wrong (e.g. stale GitHub Desktop config), set the LOCAL override in this repo before the commit:

   ```bash
   git config user.email bahadirarda@users.noreply.github.com
   git config user.name bahadirarda
   ```

2. Inspect the change:

   ```bash
   git status
   git diff --staged
   git diff
   ```

3. Group the change into a single logical unit. Do not mix unrelated refactors with feature work. If multiple logical units are present, stage and commit each separately.

4. Stage only the files that belong to this commit. Avoid `git add -A` or `git add .` — they can sweep in secrets, generated files, or unrelated edits.

5. **Session progress gate — MANDATORY, not milestone-gated.** Read the index at `docs.local/sessions/README.md`; for **every** row whose Status is `draft` or `in-progress`, that session's `progress.md` MUST be touched (mtime newer than any staged file) **before** running `git commit`. The husky `pre-commit` hook (`.husky/pre-commit`) enforces this — if a session's `progress.md` is stale, the commit aborts.

   **What the agent writes (only when there is something to say).** The auto-baseline (`- <hash> <subject>` line) is appended by the husky `post-commit` hook (`.husky/post-commit`); the agent never types a hash. The agent's job is to write *supplements* under a `### YYYY-MM-DD HH:MM — Commit <N> about to land` sub-heading **before** the commit:

   ```md
   ### 2026-04-19 23:45 — Commit 7 about to land
   - **Deviation:** commit diverges from the ratified plan; state the deviation and the justification. Cross-link the `implementation-plan.md §` that is now stale.
   - **Docs debt:** commit touches public surface (`packages/*/src/types/`, exported `index.ts` barrels, wire schemas, CLI flags, API routes). The `update-docs` skill will clear this at freeze time; queuing here makes the debt visible.
   - **Tests:** new tests added or modified; one-line summary of coverage shift.
   ```

   If the commit has no supplements (no deviation, no docs debt, no test shift), the agent still must touch `progress.md` for the pre-commit gate — the simplest way is a one-line `### HH:MM — Commit <N> about to land` sub-heading with no bullets, or a single bullet "no supplements". The auto-baseline arrives after the commit and is the canonical record.

   **Multi-session rule.** The `pre-commit` and `post-commit` hooks both walk every active session. The agent supplements only the sessions a given commit actually impacts; sessions with no supplement get only the auto-baseline (which by convention means "no impact on this session's scope").

   **`docs.local/` is gitignored**, so progress.md never enters a commit. The discipline is the synchronous-update timing, not commit contents. The post-commit hook reads `git log -1 --format='%h %s'` and appends the baseline line to each in-progress session's `progress.md`; today's `## YYYY-MM-DD` heading is created if missing.

   If no in-progress session exists, this step is a no-op.

6. Write the commit message in Conventional Commits form:

   <format>
     <type>(<scope>): <subject>

     <body — optional, wrap at 72 cols>
   </format>

   <types>
     - `feat` — new user-visible capability.
     - `fix` — bug fix.
     - `refactor` — internal shape change, no behavior change.
     - `docs` — documentation-only change.
     - `test` — test-only change.
     - `chore` — tooling, deps, config.
     - `build` — build system / release tooling.
     - `ci` — CI workflow change.
     - `perf` — measurable performance improvement.
   </types>

   Scope is the package or area: `sdk`, `contracts`, `cli`, `api`, `agents`, `computer-use`, `docs`, `workflow`, `conventions`, etc.

7. Create the commit with `git commit -m "..."` using a HEREDOC for multi-line messages to preserve formatting.

8. Verify after commit:

   ```bash
   git log -1 --pretty=full
   git log -1 --format=%h
   ```

   Confirm the author email matches `bahadirarda@users.noreply.github.com`. The husky `post-commit` hook has already appended the baseline `- <hash> <subject>` line to every in-progress session's `progress.md` — no manual hash backfill needed. If the hook is unavailable (e.g. fresh clone before `pnpm install`), append the baseline by hand using the hash from `git log -1 --format='%h %s'`.
</procedure>

## Hard rules

<hard_rules>
- Identity: must be `bahadirarda <bahadirarda@users.noreply.github.com>`. A single wrong-author commit on a release branch in the past required filter-branch + force-push remediation — this check is non-negotiable.
- No AI co-author trailers. Do NOT append `Co-Authored-By: Claude ...` or any AI identity. This repo's commit convention forbids them.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- Never amend an existing commit when a pre-commit hook has failed — the commit did not happen; create a new commit instead.
- Never use `git add -A` or `git add .` — stage by named path.
- Never push without explicit user approval. Committing and pushing are separate actions.
- **Progress gate is NOT judgement-based.** Every active session's `progress.md` must be touched (mtime newer than the staged files) before `git commit` runs. The husky `pre-commit` hook (`.husky/pre-commit`) machine-enforces this; the husky `post-commit` hook (`.husky/post-commit`) appends the auto-baseline `- <hash> <subject>` line. The agent's manual responsibility narrows to writing supplements (Deviation, Docs debt, Tests) when applicable. A six-commit gap between 2026-04-18 and 2026-04-19 on `ses_001-hierarchy-redesign` required post-hoc reconstruction from commit bodies — this rule plus the hook exists because that has already happened.
</hard_rules>

## Output

- Commit hash + subject line.
- Confirmation that author identity is correct.
- Progress log entry (if an in-progress session exists) — always, per step 5.
- Docs-debt queue line (if public surface was touched) — enqueued in the progress entry.
