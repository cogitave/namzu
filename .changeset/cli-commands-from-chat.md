---
"@namzu/cli": minor
---

You can ask for your Namzu commands in words. "Set a goal: write the changelog" or "turn on fast mode" now makes the model run `/goal` or `/fast` for you through a new `command` tool, in the interactive terminal only (not delegated agents, scheduled runs or headless runs). Each slash command declares what the model may do with it: read forms run at once, changing forms ask you first with the exact line (answer no and nothing runs), and commands such as `/login`, `/config`, `/settings`, `/peers`, `/plugins`, `/permissions` and `/exit` are never run by the model, which tells you to type them. Commands that end or replace the conversation run after the reply ends.

Behaviour change: the model's `switch_model` tool now asks you to approve each model change. Before, a request in chat switched the model with no question. Nothing is needed to keep the new behaviour; to switch without being asked, type `/model <model>` yourself.
