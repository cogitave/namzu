---
"@namzu/cli": minor
---

Offer the `monitor` tool: the model can start a command and be told about each line it prints while it keeps working, instead of polling. It is deferred (found with `search_tools`) and absent when `NAMZU_DISABLE_BACKGROUND_TASKS` is set; nothing changes unless the model uses it. An idle terminal session now starts a turn when a monitor reports, as it does for a finished workflow. `namzu exec` and `exec --json` no longer exit while a monitor they started is still watching: they wait for it, let the model reply to what it reported, and exit when none is left (a watch is capped at 10 minutes there). Over ACP, events that arrive between prompts ride with the next prompt. The footer counts monitors apart from shells, and `/jobs` and Desktop list one as `Monitoring: <description>`.
