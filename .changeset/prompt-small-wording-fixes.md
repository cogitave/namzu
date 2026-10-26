---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Prompt wording and structure, with no public API change. The operator's wording for a compaction summary now sits in a labelled block that only a per-request closing tag ends. The background-start, moved-to-background and queued-agent tool results state facts and leave the usage advice to the `bash`, `job`, `wait_for_job` and `Agent` descriptions. The note about removed credential-shaped variables gives their count, not their names. The workflow size guideline moves from the `workflow` tool description to the system prompt beside the workflow rules, so a changed setting no longer rewrites the tool definitions. The browser description drops the engine id. `schedule`, `ask_user_question` and `browser_act` each show one sample call. The 12000-character payload cap, the branch rule and the no-apology rule give a reason, and the schedule skill drops text the `schedule` description already holds. A host or test that matched these sentences by text should match the new ones.
