---
'@namzu/cli': minor
---

`namzu exec --json` writes one new `init` event before the turn starts, after any notices: `cwd`, `provider`, `model`, `permissionMode`, `tools`, `mcpServers` (each with `connected` or `failed`), `slashCommands`, and `sessionId` when `--session` is used. A host that rejects event kinds it does not know should accept `init`; every other event is unchanged.
