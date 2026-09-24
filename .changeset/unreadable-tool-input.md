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

**Tool-call framing.** A stream that puts a second call id on a tool-call `index` now fails the turn's model call with a `ProviderRequestError` (`kind: 'server'`, which pauses the turn), and `collectChatCompletion` throws an `Error`. Both name the violation. Before, the second call's arguments were appended to the first's, which left one call no tool could run. A custom driver that sends parallel calls on one index must give each call its own index.

Arguments sent before a call's id are kept for the call at their index, by the turn loop as well as by `collectChatCompletion`, which always kept them. The turn loop used to drop them, so the call failed to parse and was reported as cut off. A call whose id never arrives is given one by the turn loop; it used to reach the executor with an empty id. `tool_input_delta` no longer comes before its call's `tool_input_started`: arguments that arrive before the call's id and name are sent in one delta right after it.

**`MockLLMProvider`.** A `truncateArguments` call now does what its documentation said: it sends only the first half of the arguments, and the turn finishes with `length` unless the script sets `finishReason`. It used to send the whole JSON, so nothing was truncated. A test that relied on that call running must drop `truncateArguments`.

See `docs/sdk/unreadable-tool-input.md`.
