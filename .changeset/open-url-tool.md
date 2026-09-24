---
"@namzu/cli": minor
---

New `open_url` tool: in the interactive terminal and `namzu exec`, the model can open an http(s) page in your default browser (under WSL, the Windows browser) instead of guessing a shell command. It is a `network` tool, so `prompt` mode asks before it runs. Add a `[permissions]` rule for `open_url` to allow or deny it. `exec --json`, `drain`, ACP, scheduled runs and sub-agents do not have it. Each request in those two surfaces now carries about 120 more tokens of tool schema.
