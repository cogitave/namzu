---
name: start-session
description: Use this skill whenever the user begins new non-trivial design, architectural, refactoring, investigation, or planning work that deserves a decision log. Triggers include requests to design a feature, plan a refactor, propose an approach, explore options, or work through any change that spans multiple decisions. Always prefer opening a session over working in-place on work that will produce durable decisions or span more than one exchange. Do NOT use for trivial fixes such as typos or one-line bug fixes.
---

# Start Session

Opens a new working-memory folder under `docs.local/sessions/` to capture scope, decisions, plans, progress, and open questions for a focused piece of work. Sessions are the agent's durable memory across turns, across agents, and across `/clear`.

## When to trigger

<triggers>
- User asks to design, plan, refactor, investigate, propose, or explore something.
- A decision spans more than one exchange.
- Work will produce durable architectural output (entity model, API shape, migration).
- Multiple agents may need to cooperate on the same effort.
</triggers>

<not_triggers>
- Single-file bug fix or typo correction.
- Pure factual answer without any decision being made.
- Continuing work in an already-open session — use `resume-session` instead.
</not_triggers>

## Steps

<procedure>
1. Read `docs.local/sessions/README.md` to find the next sequential ID and re-read the current conventions (status values, freeze rule, layout).

2. Pick a slug:
   - 2–4 lowercase words, hyphenated.
   - Describes the scope, not the solution (e.g. `auth-refactor`, `pricing-model`, not `use-oauth-v2`).

3. Create the folder:
   ```
   docs.local/sessions/ses_<NNN>-<slug>/
   ```

4. Scaffold the standard files inside it:

   <file name="README.md">
     - Status: `draft`
     - Date opened (YYYY-MM-DD)
     - Scope (1–2 sentences)
     - Supersedes (link to prior session if applicable)
     - Index of files present
     - Decisions made (grows as work progresses)
     - Decisions deferred (points to open-questions.md)
   </file>

   <file name="progress.md">
     Append-only progress log. Every meaningful step gets an entry with timestamp + what was done + next step. This is the primary source for resumption after `/clear`.
   </file>

   <file name="design.md" optional="true">
     The actual design document. Create when design content exists.
   </file>

   <file name="implementation-plan.md" optional="true">
     Phased rollout plan. Create when implementation is planned.
   </file>

   <file name="open-questions.md" optional="true">
     Decisions pending user input. Create when unresolved questions exist.
   </file>

5. Update `docs.local/sessions/README.md` index table with the new row: ID, slug, status, opened date.

6. Write the first `progress.md` entry:
   ```md
   ## YYYY-MM-DD

   ### Session opened
   - Created folder ses_<NNN>-<slug>/
   - Scaffolded: README.md, progress.md, [other files created]
   - Status: draft
   - Next: [what the immediate next action is]
   ```
</procedure>

## Progress discipline

<discipline>
Every subsequent meaningful step in this session MUST append to `progress.md` BEFORE moving on. This is non-negotiable — the log is what allows a fresh agent (after `/clear` or handoff) to resume without context loss.

An entry has three parts:
1. What was just done (past tense, specific).
2. Current state of the session's artifacts.
3. The immediate next step (concrete enough to act on).
</discipline>

## Output

Return:
- Path to the new session folder.
- One-line summary of scope.
- The `progress.md` entry written.
- The immediate next action for the user / next turn.
