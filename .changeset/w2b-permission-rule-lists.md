---
'@namzu/cli': minor
---

`permissions` now also accepts `allow`, `ask` and `deny` lists of rule strings such as `Bash(git push:*)`, `Read(./.env)`, `WebFetch(domain:example.com)` or `mcp__files__delete`, so rules written in that common form work as they are. They are folded into the per-tool table when the config loads and join across layers like the table does; the table keeps working and can be used beside them. An entry that is not a rule stops the file loading and the message names the list and position. Nothing to change to keep working, unless a tool of yours is literally named `allow`, `ask` or `deny` with a list value.
