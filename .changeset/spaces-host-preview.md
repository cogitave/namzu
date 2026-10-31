---
"@namzu/cli": minor
---

Add `namzu spaces` (preview): one terminal with a sidebar and a live Namzu session beside it, started in the current folder with your environment. `ctrl+b` enters navigate mode (press it twice to send it to the session); change it with `tui.spacesPrefix`. A session that stops greys its row and leaves the host running. Nothing changes for plain `namzu`. The CLI now installs the prebuilt `@lydell/node-pty` as an optional dependency and uses it before `node-pty`, which also applies to the terminals Desktop and ACP clients open; if you pin `node-pty` yourself, nothing needs to change, as it is still the fallback.
