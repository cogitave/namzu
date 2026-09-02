---
"@namzu/cli": minor
---

A permission mode for watching the agent write code, and a change that reads as a change.

- **`accept-edits` mode.** `--permission-mode accept-edits`, `/permissions accept-edits`, or **Shift+Tab** in the composer. A batch made only of non-destructive `edit` and `write` calls (plus tools that never prompt) is approved without asking; a batch with a shell command, a delegation or anything a tool declares destructive still asks as a whole. Deny rules and the dangerous-pattern floor sit above it as above every mode. Shift+Tab toggles `prompt` ⇄ `accept-edits`; `auto` and `strict` are chosen by name. The composer shows the mode beside the input whenever it is not `prompt`.
- **Edit and write approvals show the change.** The readable review for an `edit` shows the path, then the removed lines as `-` and the added lines as `+`, coloured; a `write` shows the file it creates. Forty lines a side, the remainder counted. The exact prepared input is still behind `d`, byte for byte, and any shape the summary does not fully recognise opens there first as before.

`PERMISSION_MODES` gains `accept-edits`; a consumer validating modes against the old three-member list should add it. Nothing else on the surface changed.
