---
"@namzu/cli": patch
---

A transcript row keeps its column when it settles into scrollback. Settled rows used to lose the one column of padding live rows have, so a finished screen mixed rows starting at column 0 and column 1. The brand header, printed the same way, moves one column right with them. Nothing to do on upgrade.
