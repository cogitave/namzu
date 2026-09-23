---
"@namzu/cli": patch
---

A transcript row keeps its column and its wrap when it settles into scrollback. Settled rows used to lose the one column of padding live rows have, so a finished screen mixed rows starting at column 0 and column 1, and a long settled row wrapped two columns wider than it had while live. The brand header, printed the same way, moves one column right with them. Nothing to do on upgrade.
