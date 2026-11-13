---
'@namzu/cli': minor
---

Hooks moved from the common hook contract behave as written. Shell hooks get a call id on every tool event (`tool_use_id`), the file of a file tool as `file_path` beside `path`, and may answer `updatedToolOutput` in any JSON shape (and `updatedMCPToolOutput` for tool-server tools); a matcher or `if` written as a pattern, a glob or a list of names fires as written, including `if: "Agent"` and a shell command run through `env`, `sudo`, `nohup` or `git -C`. A sub-agent's hooks (`subagent_start`, `subagent_stop`) now carry the agent's name (`reviewer`, `explore`) as `agent_type`; it was `namzu-cli` for every child, so a script that compared it to that word must compare to the name.

`/hooks` says under a hook whose `matcher` is not a valid regular expression, or whose `if` is not `Tool(pattern)`, that it cannot be read; `namzu doctor` warns (`runtime.hooks`) and names it. A matcher that does not compile now fires for every call instead of never (it used to match nothing, so the hook never ran): fix the pattern the row names.
