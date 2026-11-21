---
"@namzu/cli": major
---

Namzu now removes old conversations by default, and keeps prompt history across conversations.

What changes for you: `cleanupPeriodDays` (default 30, minimum 1) removes a conversation from this computer when nothing in it has changed for that many days. The sweep runs at most once a day when the terminal app starts. It never touches a conversation with an open turn, a live writer, a desktop-started conversation or an untrusted folder. The first start after upgrading only counts and tells you once, and deletes nothing for seven days; a period you set yourself applies at once. To keep everything, set `cleanupPeriodDays: 3650` (or any large number) in `~/.namzu/config.yaml` before then; a project file cannot set it. The same start clears old scratch folders, dead hook folders and dangling short names from the private temp folder.

New: `~/.namzu/history.jsonl` (mode 0600) records the prompts you send from the box, so Up and Ctrl+R in a new conversation recall the project's earlier ones; pasted text is read back from the conversation's log, not copied. Set `promptHistory: false` to stop writing it. The first start in a project seeds it from its newest 20 conversations.
