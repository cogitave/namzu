---
"@namzu/cli": minor
---

The `hooks` config key accepts every shell hook event the kernel has — `user_prompt_submit`, `session_start`, `session_end`, `pre_compact`, `post_compact`, `subagent_stop` alongside the four it had — and the session fires `session_start` before its first turn (with the conversation's durable id) and `session_end` when it closes. `/hooks` lists the hooks this session runs, by event. `/exit` now closes the session before the process leaves — background jobs are stopped, MCP servers closed, `session_end` runs — where it used to leave with everything still running.
