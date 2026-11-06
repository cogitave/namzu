---
'@namzu/cli': minor
---

A third decision point, `skill-worthy`: with `decision.points.skill-worthy` set to `shadow` or `on`, a skill suggestion the usual rule made is put to your decision model, which sees your request (cut at 600 characters) and the names of the tools used, never their arguments or results. In `shadow` the answer is only logged; in `on` a confident no withdraws the suggestion. It never adds a suggestion the rule did not make, and nothing is saved either way. Off unless you name it.
