---
'@namzu/anthropic': minor
---

A forced tool choice that the vendor always rejects is now refused before it is sent. This covers `toolChoice: 'required'` and a named function on Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1. It also covers a forced choice on any model when the request carries manual extended thinking (`thinking: { type: 'enabled' }` after the driver resolves it). These requests used to go to the API and fail there with a 400. On the three models the message is `tool_choice: type "tool" and "any" are not supported for this model.`

What changes for you:

- **The request still fails, but earlier.** You get a `ProviderRequestError` with `kind: 'bad_request'` and `providerCode: 'forced_tool_choice_unsupported'`. It has no HTTP `status`, because nothing was sent. The message tells you what to use instead: `toolChoice: 'auto'` with the tool named in the prompt, or `responseFormat` for a fixed JSON shape.
- **New export `acceptsForcedToolChoice(model, thinking?)`.** It says whether a forced choice will be taken, using the same resolution the request uses. Use it to decide whether a `prepareStep` stage can force a call on the model it is about to run.
- **No change** for `'auto'` or `'none'`, or for forced choices on models that accept them (`claude-opus-5`, `claude-fable-5`, `claude-sonnet-5` and earlier, with adaptive thinking or none).
