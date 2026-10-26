---
"@namzu/cli": minor
---

New `namzu learn` and `namzu learning` commands: the same as `namzu resident learn` and `namzu resident learning`, which keep working. Conversations in the terminal and `namzu exec` now keep failed tool calls, provider errors and turns that stopped early as local learning observations (a reference to the turn and one short redacted sentence, never your prompt or the answer, stored under the project's state directory and dropped after 30 days). Nothing is uploaded, and they only feed `namzu learning --observations`. To turn it off, set `learningObservations: false` in your config.
