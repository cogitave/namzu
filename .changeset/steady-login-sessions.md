---
"@namzu/cli": patch
---

Keep packaged TUI installs on the renderer versions exercised by Namzu's PTY
suite, preventing subscription login from allocating an unbounded terminal
frame after dependency resolution. `/login` now separates reusable Claude and
Codex device sessions from new Namzu-owned sign-ins, and reports when the host
has no browser launcher instead of claiming one opened.
