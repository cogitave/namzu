---
'@namzu/sdk': patch
'@namzu/cli': patch
---

The `skill` tool now presents its calls as `Read skill <name>` (or `List skills`) and hides a successful result, so a host shows one row instead of the raw input and the skill's body. In the TUI, the Working row says `Waiting for you` while the screen that saves a skill is open, instead of counting on as if the turn were working.
