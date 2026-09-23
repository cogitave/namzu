---
"@namzu/cli": patch
---

A transcript row written while the reply above it is still streaming no longer reaches scrollback before that reply. It used to settle first on a short terminal; when the reply then finished it was placed below rows already printed, so one row was printed twice and the reply's sentence was never printed. Nothing to do on upgrade.
