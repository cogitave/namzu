---
"@namzu/cli": patch
---

Closing a terminal on Linux no longer leaves a program running that was switching programs (inside `exec`) at the moment the host read its environment. That read comes back empty for an instant, so the sweep that ends every process carrying the terminal's `NAMZU_TERMINAL_ID` skipped it. An empty environment is now read again a few times before it is believed. Nothing to do to take this.
