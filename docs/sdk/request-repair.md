---
type: Reference
title: Repairing a request the provider rejects
description: How the runtime repairs and resends a request a provider rejects as invalid, so a conversation does not dead-end on a 400.
resource: packages/sdk/src/runtime/query/iteration/request-repair.ts
tags: [sdk, providers, errors, recovery]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Repairing a request the provider rejects

A 400 that is not a context overflow is classified `bad_request`. It used to settle the turn, because resending the same request fails the same way. Most such rejections name something that can be changed in the request, so the runtime changes it and resends. Nothing is shown unless media was removed.

Every edit is made to the **outgoing request only**. The stored conversation keeps its bytes and its reasoning, and what a repair has proved is derived again on every later model call of the run.

**Nothing is remembered on a guess.** A repair is a guess about what the provider objected to. A parameter to leave out, reasoning to strip, media to omit and a media limit are kept for the run only once a resend without them was accepted. A guess that did not fix the request is forgotten and the original rejection is thrown. What is remembered is keyed by the member that served the call, so one member of a fallback chain refusing a parameter says nothing about the others.

The repair covers the agent loop's model calls (each turn and the closing summary). Other calls to a provider, such as compaction summaries, do not pass through it.

## The steps

| The provider rejects | The runtime does | Remembered once a resend is accepted |
|---|---|---|
| Unpaired tool history (a call without a result, a result without a call, a duplicated result) | Runs the shared `repairToolMessageHistory` on the outgoing messages before each model call. A call the log proves never started (its turn journals calls and it has no `tool_executing` record) gets a result saying it did not run; any other call without a result is reported as of unknown outcome (`repairToolMessageHistory(messages, { neverRan })`). A tool-history 400 that still arrives repairs once more and resends once. | No: it is recomputed each call |
| A reasoning or thinking block or signature (for example after switching model) | Removes the reasoning blocks and their replay state from the outgoing request, and with them the `thinking` parameter when it is on (a tool turn without a thinking block is itself refused while thinking is on). A debug log line only. | Both, per serving member |
| An unsupported `effort`, `thinking`, `temperature`, `topP` or `responseFormat` | Removes that parameter and resends. A debug log line only. | The parameter, per serving member |
| An image or document it cannot process, naming a message and block | On the Anthropic and OpenAI wires, whose layout is mapped exactly, replaces that block's media with a text note, at most three times per index | The media, by content |
| The same on another wire, or naming no message | Replaces the media of the newest message that carries some | The media, by content |
| "Too many images", "unprocessable" images, or a 413 or 422 that names media on a request holding some | Keeps only the newest 510, then 255, then 127 media, then half of what is left, down to none | The limit |

A parameter is only dropped when the provider's words say it is unsupported (or it sent `unsupported_parameter` / `unsupported_value` with the parameter named) and the request actually set it; a name that appears inside a tool schema path (`tools.2…input_schema.properties.temperature`) never counts. Media wording must name an image, picture, document or PDF fault; a bare 413 or 422, or a tool-schema error, is left alone and keeps the person's attachments.

A rejection that matches none of these, or that survives every applicable step, settles the turn as it did before. One original request makes at most five repair resends in total, across the retries of the image recovery that wraps it.

Media notes read "[image removed: the provider could not process it. …]" for a faulty file and "[image removed: this conversation holds more files than the provider accepts at once …]" for a count limit. A message index such as `messages.3.content.1` counts the provider's wire array. The Anthropic wire (system turns left out, a run of consecutive tool results as one entry, a user turn after tool results as its own entry) and the OpenAI wire (one entry per message, system included) are mapped back exactly; for any other driver the index is not trusted and the newest media is removed instead.

A single distinct image the provider calls invalid, and a text-only model, keep their own recovery described in [Text-only models and images](text-only-models-and-images.md); this one handles everything else.

## What is shown

When media was removed from a request that then went through, one `capability_warning` is emitted, with `capability` `'vision'` or `'documents'` and one of three `contentSource` values: `'media-removed'` (a faulty file), `'media-removed-current'` (the removal included a file attached to the latest message, and the line says "you just attached"), or `'media-limit'` (the oldest files were left out only to fit a count, which is no fault in any file). The terminal says so in plain words and that the file stays in the conversation; it never suggests starting a new conversation. None of these marks a model as unable to read images.

## Not covered

- Hosted web search the provider does not support, and native structured output it does not support, are refused locally before the request is sent (`hosted_web_search_unsupported`, `native_structured_output_unsupported`). The SDK has no fallback tool to switch to: the terminal already picks the common `web_search` tool when the provider cannot search, and structured output mode is the host's choice at the start of a run.
- A duplicated tool-call id fails closed in `repairToolMessageHistory`, because rewriting a signed assistant turn is unsafe. The request is sent as it is.
