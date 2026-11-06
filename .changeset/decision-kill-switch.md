---
'@namzu/cli': patch
---

`NAMZU_NO_DECISION=1` in the environment turns every use of your decision model off at once: the decision points, `model: auto` routing and the `decide` tool, whatever `decision` says in your config. Without it nothing changes.
