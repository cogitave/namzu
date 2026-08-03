---
'@namzu/openai': minor
'@namzu/bedrock': patch
'@namzu/http': patch
'@namzu/lmstudio': patch
---

Four drivers dumped tool-result payloads into the prompt, and one ignored the strict-schema hint.

**A tool result carrying an image was `JSON.stringify`d** on four drivers, so a screenshot reached the model as a wall of quoted base64. The model paid for every character, could read none of them, and — worse — saw a serialized object where a picture should be, with nothing saying anything had been withheld. The SDK's `toolResultToText` exists for exactly this and produces a named placeholder reporting the media type and the size. All four now use it: `@namzu/bedrock`, both dialects of `@namzu/http`, and `@namzu/lmstudio`.

**`enforceToolInputSchema` was ignored by `@namzu/openai`.** It names the tools whose model-facing schema should be enforced by constrained generation rather than merely suggested; both sibling drivers consumed it. A caller who had asked for a guaranteed-valid tool input silently got a best-effort one and learned about it from a repair attempt. This is the wire the flag maps onto most directly — it takes the flag on the function itself. The existing test asserting the tools went through untouched read as "the hint is kept out of the request" and actually pinned "the hint does nothing"; it now asserts the hint is consumed and still never appears verbatim.

**An extended-thinking request is refused by `@namzu/openai` rather than dropped.** The parameter was accepted and ignored, so a caller who asked for reasoning got an ordinary completion with an empty reasoning list — which reads as "the model did not reason" rather than "nobody asked it to". Turning thinking off stays a no-op, since that is the state the driver is already in.

Eleven previously empty test files now cover these drivers, including the capability claims themselves: every driver that declares no vision, documents or tools is pinned against drift in both directions, because the runtime warns or fails on those flags before a request is built, and a flag flipped ahead of its mapping is as wrong as a mapping written without the flag.
