---
name: codex-check
description: Use this skill after drafting any non-trivial plan, design, or implementation approach to obtain an adversarial second opinion from Codex. Triggers include "get a second opinion", "check this plan", "what did I miss", completion of a `design.md` or `implementation-plan.md`, or before executing a migration, refactor, or public-surface change. Always use on non-trivial work — skip only for typo fixes and one-line edits. The value of this skill is push-back, not confirmation; generic praise returned by Codex is discarded.
---

# Codex Check

Runs an adversarial review pass with Codex to surface flaws, missed edges, convention drift, and hidden assumptions in a draft plan or design. The prompt is framed as attack, not approval, so Codex returns critiques rather than agreement.

## When to trigger

<triggers>
- A session has a filled `design.md` or `implementation-plan.md` and has not yet been executed.
- About to start a multi-phase refactor or migration.
- About to change a public surface (wire schema, CLI command, exported type).
- User asks for a sanity check, red-team review, or second opinion.
</triggers>

<not_triggers>
- Trivial fixes (typo, single-line bug).
- Work entirely inside a single private function with no cross-package effect.
- A plan already reviewed by Codex in this session with no material changes since.
</not_triggers>

## Steps

<procedure>
1. Identify the artifact to review — usually a `design.md`, `implementation-plan.md`, or a PR description in the current session.

2. Frame the prompt adversarially. Do NOT write "does this work?" — write prompts like:

   <prompts>
     - "Find what is broken in this plan."
     - "What edges does this miss?"
     - "What would break this implementation at scale / under concurrency / on partial failure?"
     - "Where does this drift from the conventions in `docs.local/conventions/`?"
     - "What hidden assumption is this plan making that is not stated?"
     - "If you had to kill this design, what angle would you attack?"
   </prompts>

3. Invoke Codex via the `codex:codex-rescue` plugin (or equivalent). Pass the artifact contents and the adversarial prompt.

4. Triage the response:
   - **Concrete critique** (named risk, specific edge, convention breach) → capture in the session under "Open questions" or "Risks identified".
   - **Generic praise** ("looks good", "well structured") → discard. Do not treat this as validation.
   - **Convention drift flagged** → re-read the cited rule in `docs.local/conventions/`; if the drift is real, either align the plan or open a deviation discussion before continuing.

5. Append to `progress.md`:
   ```md
   ### YYYY-MM-DD HH:MM — Codex check
   - Artifact reviewed: [file]
   - Prompt style: adversarial (attack)
   - Concrete critiques: [count, short titles]
   - Actions: [aligned plan / opened decisions / dismissed as noise]
   - Next: [concrete step]
   ```
</procedure>

## Discipline

<discipline>
- Never treat Codex agreement as safety. Codex can be wrong in both directions.
- Always surface concrete blockers in the session, even if you disagree. The decision log must show they were considered.
- If Codex returns only generic praise, re-prompt with a more specific attack angle. Do not stop there.
</discipline>

## Output

- Count of concrete critiques returned.
- For each: one-line title + whether it was adopted, deferred, or dismissed (with reason).
- Updated `progress.md` entry.
