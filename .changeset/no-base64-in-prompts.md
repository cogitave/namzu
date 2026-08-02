---
'@namzu/bedrock': patch
'@namzu/openrouter': patch
'@namzu/lmstudio': patch
'@namzu/http': patch
---

Stop dumping a tool result's base64 payload into the prompt.

Four drivers mishandled a tool result carrying content blocks, each in its
own way: bedrock and the http driver's anthropic dialect `JSON.stringify`d
the whole array, putting a screenshot's base64 into the prompt as JSON
text; openrouter and the http driver's openai dialect passed the array
through raw to an endpoint expecting a string; lmstudio folded it into a
template literal, producing `[object Object]` per block. The model cannot
decode any of it, and it costs a fortune in tokens.

- The three text-only wires now flatten with the SDK's existing helper,
  which names a non-text block and its size instead of inlining it. The
  openai and ollama drivers already did this — the helper was there and
  four callers were missing.
- **bedrock sends the image as an image.** That wire carries images
  natively, so a placeholder would be a downgrade the other drivers accept
  only because their format has no room for one. Text and image survive as
  separate blocks in order, and a media type the format does not accept
  still degrades to a named placeholder rather than being smuggled through
  as text.
