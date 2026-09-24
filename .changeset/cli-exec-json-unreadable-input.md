---
'@namzu/cli': patch
---

`namzu exec --json` now writes a `tool-input-unreadable` event for a tool call whose streamed arguments could not be read, before the call's `tool-start`. It carries `toolUseId`, `turnId`, `inputError` (whose `reason` says whether the arguments were cut off, `truncated`, or were not valid JSON, `malformed`) and `partialArguments`, the first 16 384 characters of what the model sent. A host used to see only the failed `tool-end`, so it could not tell the two apart or record what was sent. A host that line-scans by `kind` and ignores kinds it does not know needs no change.
