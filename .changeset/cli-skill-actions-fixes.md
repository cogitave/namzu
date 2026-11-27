---
'@namzu/cli': minor
---

The desktop host holds at most 64 MiB of unpacked files per stage and 128 MiB across stages when skills are staged; an item past the limit is reported as an error and the oldest stage is dropped first. `namzu/mcp/save-user-server` in edit mode now clears the headers when given `headers: {}` and removes them when an address is changed to a command; omitted headers are still kept. A program that edits a server from an address to a command and relied on the old headers staying in the file must write them again.
