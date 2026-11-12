---
'@namzu/evals': minor
---

New suite `kernel/call-did-not-run`: with a scripted model it checks that a declined command, a command a rule refused, a call to a tool that is not there and a mere background sub-agent launch leave the turn's outcome `unchanged`, and that a command that ran still says `unknown`. The case in `kernel/hand-back` that calls a tool that is absent now expects `unchanged`, where it expected `unknown`.
