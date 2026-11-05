---
'@namzu/cli': minor
---

A second decision point, `memory-admit`: with `decision.points.memory-admit` set to `shadow` or `on`, the decision model is asked whether what a turn learned (its requirements, decisions, discoveries, failures and environment facts, never file paths) is worth remembering before the session writes its stored memory. In `shadow` the answer is only logged; in `on` a confident no writes nothing, and anything else, a failure included, writes as before. It runs after the reply is settled and is off unless you name it.
