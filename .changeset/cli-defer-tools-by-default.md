---
'@namzu/cli': major
---

Tool schemas are now deferred by default. A session used to send all of its roughly 28 tool schemas on every request; it now sends `read`, `glob`, `grep`, `write`, `edit`, `bash`, `job`, `wait_for_job`, `skill`, `search_tools`, `Agent` and `ask_user_question`, and lists every other tool (web search and fetch, conversation search, memory, tasks, workflow, `browser`, `browser_act`, `computer_use`, `code_analysis`, `monitor`, coordinator tools, MCP tools) by name and one line, to be loaded with `search_tools` before its first call. This changes what a model sees on its first request and what `AgentSessionOptions.toolLoading` means when unset: it was `'eager'`, it is now `'deferred'`. A host or script that relied on a tool's schema being present up front must pass `toolLoading: 'eager'` to keep the old behaviour. `narrate_work` and `ask_user_question` follow the same rule: `ask_user_question` stays resident, `narrate_work` is deferred.
