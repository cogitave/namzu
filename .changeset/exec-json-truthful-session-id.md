---
"@namzu/cli": major
---

`namzu exec --json` without `--session` no longer puts a `sessionId` in its `usage` and `done` events. That run keeps no record, so the id it showed could never be passed to `--resume` or `--continue`. A host that read the id from a stateless run should pass `--session <key>` to get a resumable conversation and a stable id.

`--session <id>` now opens the conversation when the value is the id of one of this folder's conversations, instead of silently starting a new empty one under that text. If the id belongs to a conversation in another folder the command refuses and points to `--resume` and `--cwd`. Any other value, including a UUID with no conversation behind it, is still a host key.
