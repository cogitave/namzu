---
"@namzu/cli": minor
---

`namzu exec --json` events that carry a `sessionId` now also carry `resumable: false` when the run was started without `--session`. That run keeps no record, so its id cannot be passed to `--resume` or `--continue`. Runs bound with `--session` omit the field and their id can be resumed. `sessionId` on a run without `--session` is deprecated and will be removed in a future major release; hosts should check `resumable` and pass `--session <key>` when they need a resumable conversation with a stable id.

`--session <id>` now opens the conversation when the value is the id of one of this folder's conversations, instead of silently starting a new empty one under that text. If the id belongs to a conversation in another folder the command refuses and points to `--resume` and `--cwd`. Any other value, including a UUID with no conversation behind it, is still a host key.
