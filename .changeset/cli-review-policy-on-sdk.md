---
"@namzu/cli": patch
---

The permission modes (`prompt`, `accept-edits`, `auto`, `strict`, `plan`) now run on the kernel's review policy; the CLI supplies the terminal prompt and the session's approve-all state. Behaviour, refusal texts and the exempt roster are unchanged. `namzu run --help` now lists all five modes.
