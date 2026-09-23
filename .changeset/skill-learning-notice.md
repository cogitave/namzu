---
"@namzu/cli": minor
---

The interactive terminal now proposes saving a multi-step task as a skill. After a turn that answered with at least six successful tool calls across two or more tools (one of them changing something), it prints one dim line under the reply: `✻ That took 9 steps across 4 tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop suggesting`. It appears at most once per conversation, takes no keys and costs no model call; nothing is saved unless you type `/skills save`, which drafts the skill in the same conversation and saves it only from the confirmation screen.

To turn it off, type `/skills save off` (it writes `skills.suggest: false` to `~/.namzu/config.yaml`) or set that key yourself; `/skills save on` restores it. It also stops by itself after three proposals in a row go unused. `skills.suggestMinToolCalls` changes the threshold. `namzu exec`, `drain`, ACP, scheduled runs and sub-agents never show it.
