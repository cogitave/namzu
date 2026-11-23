---
'@namzu/cli': minor
---

The session prompt tells the model to read a page with `web_fetch` first and to open the browser only for a sign-in, a script-drawn page or interaction, and not to repeat a search or reopen a page in the same turn. `web_fetch` is always loaded in a session that defers tools, and the agent and workflow tools are loaded while hypermode is on or delegated work runs. Nothing to change on your side.
