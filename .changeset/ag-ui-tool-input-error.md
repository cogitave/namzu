---
'@namzu/ag-ui': minor
---

`TOOL_CALL_END` for a call whose arguments could not be read now says why. `metadata.namzu.inputTruncated` is set for arguments that were cut off and for arguments that were malformed alike, so it was all a host had and it could not tell the two apart. When the runtime recorded the cause, the event also carries `metadata.namzu.inputError`, the `ToolInputError` from `tool_input_completed`: `reason` is `'truncated'` or `'malformed'`, with `finishReason`, `parseError`, `offset`, `length` and `precedingLength`. Nothing changes for a host that reads only `inputTruncated`. An `@namzu/sdk` that records no cause, and arguments only the adapter found unparsable, still carry `inputTruncated` alone.
