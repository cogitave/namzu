---
'@namzu/sdk': minor
---

A tool call whose streamed arguments do not parse is now reported as **truncated** or **malformed**, and the model is told which, instead of always hearing that its call was cut off and it should send less.

**What changes for the model.** The error for an unreadable call is built from the reason and from the tool. A malformed call gets the JSON parser's error. A truncated call is told what stopped the response (the output limit, a content filter or a dropped stream). A size budget is given only if the tool declares large string arguments. The fixed text about `content`/`new_string`, a 12000-character budget and write/edit markers is gone from every other tool. If you match on the old text ("call was cut off while the model was streaming JSON arguments"), update the match.

**New, all optional:**
- `ToolInputError` (`reason: 'truncated' | 'malformed'`, `finishReason`, `parseError`, `offset`, `length`) on `ToolCall.metadata.inputError`.
- `inputError` and `partialArguments` (first 16 384 characters) on the `tool_input_completed` event. The SSE bridge sends them as `input_error` and `partial_arguments`, with `input_truncated`.
- `ToolDefinition.unreadableInputHint` and `ToolDefinition.largeStringArguments` (for example `{ content: 12_000 }`), also accepted by `defineTool`. `write`, `edit`, `create_task` and the coordinator `Agent` tool declare them.

`inputTruncated` is still set on every unreadable call, cut off or malformed, as before. Code that reads it keeps working. Read `inputError.reason` to tell the two apart.

**Refused streams.** A stream that puts a second call id on a tool-call `index`, or sends a call's arguments before its id, now fails the turn's model call with a `ProviderRequestError` (`kind: 'server'`, which pauses the turn). The `detail` names the violation. `collectChatCompletion` throws an `Error` with the same sentence. Before, the second call's arguments were appended to the first's, and early fragments were dropped. A custom driver that sends parallel calls on one index must give each call its own index.

**`MockLLMProvider`.** A `truncateArguments` call now does what its documentation said: it sends only the first half of the arguments, and the turn finishes with `length` unless the script sets `finishReason`. It used to send the whole JSON, so nothing was truncated. A test that relied on that call running must drop `truncateArguments`.

See `docs/sdk/unreadable-tool-input.md`.
