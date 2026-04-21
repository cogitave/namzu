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
0. **Pre-freeze Codex implementation-check — MANDATORY.** Before flipping any status, run one adversarial Codex pass specifically on the implementation-vs-plan gap. This is a different angle from the design-phase `codex-check`: design-phase asks "does this plan work?"; pre-freeze asks "did the implementation actually match the plan, and what drifted?".

   <prompts>
     - "Did the implementation deliver on every acceptance criterion in the session README, or were some silently skipped / tick-boxed without evidence?"
     - "Where does the actual commit history drift from the `design.md` plan? Enumerate each deviation and classify: intentional (should appear in 'Decisions made'), accidental (should be fixed before freeze), or immaterial (noise)."
     - "What failure mode would this session ship with if frozen today? Name one concrete scenario the existing smoke tests / typecheck / lint would NOT catch."
     - "If you had to reject this session's freeze, what is the single most credible reason?"
   </prompts>

   Invoke via the `codex:codex-rescue` plugin. Pass the full session state: `README.md`, `design.md`, `implementation-plan.md`, `progress.md`, plus `git log --oneline <first-session-commit>..HEAD` and the changeset file. Tell Codex which round this is (round 3+ — explicitly "post-implementation", not "pre-implementation").

   Triage identically to `codex-check`:
   - **Concrete blocker** (missing acceptance criterion, unfixed design drift, failure mode the smoke tests miss) → fix before freeze. Another commit may be required; document in `progress.md` under the pre-freeze entry.
   - **Generic praise** → discard. Do not treat as validation.
   - **New drift surfaced** → decide inline whether to amend the session (add to Decisions made, update docs debt) or open a supersession.

   Record outcome in `progress.md` as a dedicated entry:

   ```md
   ### YYYY-MM-DD HH:MM — Pre-freeze Codex check
   - Artifact: full session state + commit history
   - Prompt style: adversarial (post-implementation; drift + delivery)
   - Concrete critiques: [count, short titles]
   - Actions: [blockers fixed / critiques deferred / opened supersession]
   - Outcome: [ready to freeze / additional commit required]
   ```

   If the outcome is "additional commit required", return to the `commit` skill for the fix, then re-run step 0. Freeze does not proceed with unaddressed blockers.

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
   - Pre-freeze Codex check: [round N, critique count, outcome] (cross-link to the dedicated entry from step 0)
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

- Pre-freeze Codex check outcome (round number, critiques surfaced, whether a fix commit was required).
- Conventions extracted (list of new slugs + paths, or "none — scoped work without a cross-cutting rule").
- Published docs updated (list of paths, or "none").
- Link to the frozen session folder.
