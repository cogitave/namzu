---
"@namzu/cli": patch
---

The TUI says "turn" where it still said "run" for the unit of work that no
longer exists: `/cost`, `/status` and the status panel label spend as
"current or latest turn", a message held after a paused turn says so, the
`/config` notice names turn limits, and the headless trust refusal says a
headless turn approves tools without asking, and `namzu doctor`'s
remediation for an unusable fallback says turns will still start. Wording only; nothing a script
parses changed.
