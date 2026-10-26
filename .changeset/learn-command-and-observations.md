---
"@namzu/cli": minor
---

New `namzu learn` and `namzu learning` commands: the same as `namzu resident learn` and `namzu resident learning`, which keep working. Conversations in the terminal and `namzu exec` now keep failed tool calls, provider errors, turns that stopped early and the recoveries Namzu already makes (a provider retry or fallback, a history repair, a failed compaction pass) as local learning observations (a reference to the turn and one fixed sentence naming the tool, stop reason or error code, never the failure message, your prompt or the answer; your own cancel, a rejected plan or a plain approval pause is not recorded, stored under the project's state directory and dropped after 30 days). Nothing is uploaded. Read them with `namzu learning --sessions`; `namzu learn` does not use them yet and still needs an agent in the folder to activate into. To turn it off, set `learningObservations: false` in your config.
