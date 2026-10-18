---
"@namzu/cli": minor
---

Shift+Tab now follows the reference terminal's cycle: `prompt`, `accept-edits`, `plan`, then `auto` ("bypass permissions on") when the session may use it, then back to `prompt`; from `auto` or `strict` it returns to `prompt`. Starting with `--yolo`, `--dangerously-skip-permissions` or `--permission-mode auto` allows the stop, so one press no longer loses bypass for the rest of the session. The new `--allow-dangerously-skip-permissions` allows it without starting in `auto`, and choosing `auto` by name in `/permissions` allows it for the rest of the session. Without any of these the key behaves as before (`plan` returns to `prompt`).
