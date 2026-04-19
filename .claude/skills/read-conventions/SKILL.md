---
name: read-conventions
description: Use this skill before making any non-trivial code change, architectural decision, or refactor to ensure compliance with ratified project rules. Triggers include writing new code for a feature, refactoring existing code shape, adding a new package or entity, touching public API, or reviewing a PR for compliance. Always use before a non-trivial change. Skip only for typo fixes and documentation-only edits. Silent deviation from a ratified rule is forbidden; this skill is the way to avoid it.
---

# Read Conventions

Loads the relevant project rules from `docs.local/conventions/` before a non-trivial change, so the change aligns with decisions already ratified in prior sessions.

## When to trigger

<triggers>
- About to write new code for a feature, not just a fix.
- Adding a new package, entity, type, or public API.
- Refactoring existing code shape (folder moves, rename, extraction, barrel changes).
- Reviewing a PR for convention compliance.
- Unsure whether an approach is allowed by prior rulings.
</triggers>

## Steps

<procedure>
1. Read `docs.local/conventions/README.md` to see the catalogue of ratified rules.

2. Map the change's surface to the catalogue. Examples:
   <mapping>
     - Adding an ID type → naming / branded-IDs / id-generation rules.
     - Adding a new class → barrel / import / export / dependency-direction rules.
     - Touching error paths → error-handling / fail-fast rules.
     - Adding a provider → provider-abstraction / registry rules.
     - Changing persistence → store-pattern / atomic-writes rules.
     - Changing CLI command → CLI-conventions / commit-convention rules.
   </mapping>

3. Read each relevant rule file fully, not just its generic rule line. The `🔧 Project Implementation` section is where compliance lives.

4. Check the change against each rule:
   - **Complies** → proceed.
   - **Ambiguous** → surface the ambiguity to the user before coding; prefer opening a session via `start-session` to resolve it.
   - **Deviates** → do NOT silently deviate. Open a session via `start-session`, document the deviation's reasoning in that session's `design.md`, freeze the session, and update the affected rule file (amend or supersede).
</procedure>

## Output

- List of rule files consulted.
- One-line compliance note per rule: `complies` / `ambiguous — see session ses_NNN` / `deviation — session ses_NNN opened`.
- Empty catalogue is a valid result while conventions/ is still growing; in that case report "no ratified rules apply yet".
