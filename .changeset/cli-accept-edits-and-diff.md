---
"@namzu/cli": minor
---

Two permission modes for the two things an operator does most — watching the agent write code, and asking it to think first — plus a change that reads as a change.

- **`accept-edits` mode.** `--permission-mode accept-edits`, `/permissions accept-edits`, or **Shift+Tab** in the composer. A batch made only of non-destructive `edit` and `write` calls (plus tools that never prompt) is approved without asking; a batch with a shell command, a delegation or anything a tool declares destructive still asks as a whole. Deny rules and the dangerous-pattern floor sit above it as above every mode.
- **`plan` mode.** `--permission-mode plan`, `/permissions plan`, or Shift+Tab. Read-only tools and the task list work; any call that would change state is refused with feedback telling the agent to present its plan, and the system prompt carries a plan-mode block saying the same up front so it plans instead of probing. Leaving plan mode is the approval.
- Shift+Tab cycles `prompt` → `accept-edits` → `plan` → `prompt`; `auto` and `strict` are chosen by name. The composer shows the mode beside the input whenever it is not `prompt`.
- **Edit and write approvals show the change.** The readable review for an `edit` shows the path, then the removed lines as `-` and the added lines as `+`, coloured; a `write` shows the file it creates. Forty lines a side, the remainder counted. The exact prepared input is still behind `d`, byte for byte, and any shape the summary does not fully recognise opens there first as before.

`PERMISSION_MODES` gains `accept-edits` and `plan`; a consumer validating modes against the old three-member list should add them. Nothing else on the surface changed.
