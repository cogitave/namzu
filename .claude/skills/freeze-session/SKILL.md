---
name: freeze-session
description: Use this skill when a session's decisions are final and either the work is complete or the session has produced stable rules that should be promoted. Triggers include "freeze this", "lock it in", "we're done with this decision", "ratify these rules", or recognition that all open questions are answered and the implementation plan has been executed or consciously parked. Always use when a session transitions from in-progress to a stable decision record; this is what keeps the conventions catalogue growing and the sessions index free of stale "in-progress" entries.
---

# Freeze Session

Marks a session as the final record of its decisions, extracts any stable rules that emerged into `docs.local/conventions/`, and, if the session's decisions changed the public surface, triggers `update-docs`.

## When to trigger

<triggers>
- All open questions in the session are decided.
- Implementation plan has been executed or consciously parked.
- User confirms the decision is final.
- The session produced a rule that should now govern future work.
</triggers>

## Steps

<procedure>
1. Open the session's `README.md`:
   - Change `Status: draft` or `Status: in-progress` → `Status: frozen`.
   - Add a line: `Frozen on: YYYY-MM-DD`.
   - Move any remaining "Decisions deferred" entries into "Decisions made" (they must all be resolved to freeze).

2. Do NOT edit `design.md`, `open-questions.md`, or `implementation-plan.md` further — they become the historical record. `progress.md` gets its final entry (see step 6), then stops.

3. Identify stable rules that emerged. A stable rule is:
   - Technology-agnostic in intent (a `📐 Generic Rule`), even if it has a project-specific implementation (`🔧`).
   - Cross-cutting — applies to future work, not just this session's slice.
   - Unambiguous — a reviewer can tell whether a change complies or deviates.

4. For each stable rule, extract into `docs.local/conventions/`:

   <extraction>
     - Open `docs.local/conventions/README.md`, pick the next slug.
     - Create `docs.local/conventions/<slug>.md` using the template in that README.
     - Fill the sections: generic rule, project implementation, rationale (with back-link to this session), examples (complies / violates).
     - Add the row to the conventions catalogue table.
   </extraction>

5. If the session's decisions changed anything documented in `docs/` (public API, CLI behavior, wire shape), invoke the `update-docs` skill for each affected page.

6. Write the final `progress.md` entry:
   ```md
   ### YYYY-MM-DD — Frozen
   - Status changed: in-progress → frozen
   - Conventions extracted: [list of new convention slugs, or "none"]
   - Published docs updated: [list of docs/ paths, or "none"]
   - This session is now historical record.
   ```

7. Update `docs.local/sessions/README.md` index row: status → `frozen`, fill the "Frozen" column with today's date.

8. If this session supersedes a prior frozen session, cross-link both ways:
   - In this session's README: `Supersedes: ses_<old>/ (<brief reason>)`.
   - In the prior session's README: `Superseded by: ses_<new>/ (<brief reason>)`.
</procedure>

## Output

- Conventions extracted (list of new slugs + paths, or "none — scoped work without a cross-cutting rule").
- Published docs updated (list of paths, or "none").
- Link to the frozen session folder.
