---
"@namzu/cli": patch
---

When computer use cannot reach a desktop (a WSL process with no interactive Windows session, an ssh session with no display), the tool is still offered — with every capability off and the reason attached — rather than left out. The model sees what it cannot do and why, and a call is refused with the same reason, so it stops on the first result instead of reasoning from a tool that was never there.
