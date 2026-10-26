---
"@namzu/cli": patch
---

A delegated turn that resumes (for example after a permission answer) now gets the same system prompt a new turn gets: plan-mode instructions when the turn is in plan mode, the note on loading deferred tools, and the delegation advice only when the session has the Agent tool. Before, the resumed turn was built from a shorter second list and lacked those sections. Nothing to do on upgrade.
