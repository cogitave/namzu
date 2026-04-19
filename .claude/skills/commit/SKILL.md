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

5. **Session progress gate — MANDATORY, not milestone-gated.** Read the index at `docs.local/sessions/README.md`; for **every** row whose Status is `draft` or `in-progress`, that session's `progress.md` MUST be updated **before** running `git commit`. (The session's own `README.md` carries a `**Status:** <value>` field in the header for cross-checking.) An entry is minimum one line under an existing date heading; create today's `## YYYY-MM-DD` heading if missing:

   ```md
   - `<hash-placeholder>` <commit subject> — <what landed / why>
   ```

   Add supplementary lines as needed, each on its own bullet:
   - `**Deviation:**` — commit diverges from the ratified plan; state the deviation and the justification. Cross-link the `implementation-plan.md §` that is now stale.
   - `**Docs debt:**` — commit touches public surface (`packages/*/src/types/`, exported `index.ts` barrels, wire schemas, CLI flags, API routes). The `update-docs` skill will clear this at freeze time; queuing here makes the debt visible.
   - `**Tests:**` — new tests added or modified; one-line summary of coverage shift.

   **Multi-session rule.** When more than one session is in-progress, *every* one of them gets an entry. For commits unrelated to a given session's scope, write a one-liner under a `### YYYY-MM-DD HH:MM — Cross-session commit` heading:

   ```md
   - `<hash-placeholder>` <commit subject> — landed in ses_<other>; no impact on this session's scope.
   ```

   This is mechanical, not judgement-based: if the session is in-progress, it gets a line. The cost is one bullet per unrelated commit; the saving is that no agent has to classify scope mid-flow.

   **`docs.local/` is gitignored**, so progress.md does NOT enter the commit itself — it lives on local disk. The discipline is *synchronous update*: before `git commit`, verify with a direct Read of each in-progress session's `progress.md` that the entry exists and reflects the commit's scope. After the commit, replace the `<hash-placeholder>` token in every entry you wrote with the real short hash from `git log -1 --format=%h`. (Once the husky `post-commit` hook from `ses_002` lands, this baseline append is automatic; until then, the agent does it by hand.)

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

   Confirm the author email matches `bahadirarda@users.noreply.github.com`. Take the short hash and replace the `<hash-placeholder>` token in **every** step-5 progress.md entry you wrote (one per in-progress session) with the real hash. `progress.md` is gitignored — no follow-up commit needed, just edit the local files. (Once the husky `post-commit` hook from `ses_002` lands, this hash backfill is automatic; until then, it is on the agent.)
</procedure>

## Hard rules

<hard_rules>
- Identity: must be `bahadirarda <bahadirarda@users.noreply.github.com>`. A single wrong-author commit on a release branch in the past required filter-branch + force-push remediation — this check is non-negotiable.
- No AI co-author trailers. Do NOT append `Co-Authored-By: Claude ...` or any AI identity. This repo's commit convention forbids them.
- Never skip hooks (`--no-verify`, `--no-gpg-sign`) unless the user explicitly asks.
- Never amend an existing commit when a pre-commit hook has failed — the commit did not happen; create a new commit instead.
- Never use `git add -A` or `git add .` — stage by named path.
- Never push without explicit user approval. Committing and pushing are separate actions.
- **Progress gate is NOT judgement-based.** If any in-progress session exists, every one of them gets a `progress.md` entry **before** `git commit` runs (the file itself is gitignored, so the entry stays on local disk; the discipline is the synchronous-update timing, not the commit contents). Do not decide "this sub-step isn't a milestone yet" and skip. A six-commit gap between 2026-04-18 and 2026-04-19 on `ses_001-hierarchy-redesign` required post-hoc reconstruction from commit bodies — this rule exists because that has already happened. Once the husky `pre-commit` hook from `ses_002` lands, this gate is machine-enforced; until then, it is on the agent.
</hard_rules>

## Output

- Commit hash + subject line.
- Confirmation that author identity is correct.
- Progress log entry (if an in-progress session exists) — always, per step 5.
- Docs-debt queue line (if public surface was touched) — enqueued in the progress entry.
