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

Every edit is made to the **outgoing request only**. The stored conversation keeps its bytes and its reasoning, and the same edits are derived again on every later send of the run.

## The steps

| The provider rejects | The runtime does | Remembered for the run |
|---|---|---|
| Unpaired tool history (a call without a result, a result without a call, a duplicated result) | Runs the shared `repairToolMessageHistory` on the outgoing messages before **every** send, not only the first. A tool-history 400 that still arrives repairs once more and resends once. | No: it is recomputed each send |
| A reasoning or thinking block or signature (for example after switching model) | Removes the reasoning blocks and their replay state from the outgoing request, and resends. A debug log line only. | Per provider and model |
| An unsupported `effort`, `thinking`, `temperature`, `topP` or `responseFormat` | Removes that parameter and resends. A debug log line only. | Per provider and model |
| An image or document it cannot process, naming a message | Replaces the media of that message with a text note and resends, at most three times per index | The media, by content |
| The same, naming no message | Does the same for the newest message that carries media | The media, by content |
| "Too many images", "unprocessable", HTTP 413 or 422 | Keeps only the newest 510, then 255, then 127 media, then half of what is left, down to none | The limit |

Classification uses the provider's structured code where there is one (`invalid_encrypted_content`, `invalid_image`, `unsupported_parameter`, `unsupported_value`) and wording only as a fallback, and a parameter is only dropped when the request actually set it. A rejection that matches none of these, or that survives every applicable step, settles the turn as it did before.

Media notes read "[image removed: the provider could not process it. The file may be unsupported or corrupt; do not retry reading it. If you need to inspect it, use a shell command instead.]". A message index such as `messages.3.content.1` counts the provider's wire array, which merges consecutive tool results, so it is mapped back to a Namzu message approximately; a miss falls back to the newest media. All media of the mapped message is replaced, not only block `content.1`.

A single distinct image the provider calls invalid, and a text-only model, keep their own recovery described in [Text-only models and images](text-only-models-and-images.md); this one handles everything else.

## What is shown

When media was removed from a request that then went through, one `capability_warning` is emitted with `contentSource: 'media-removed'` and `capability` `'vision'` or `'documents'`. The terminal says a picture or document could not be processed, that Namzu left it out of what it sends, and that it stays in the conversation. It never suggests starting a new conversation. A `capability_warning` with `contentSource: 'media-removed'` does not mark a model as unable to read images.

## Not covered

- Hosted web search the provider does not support, and native structured output it does not support, are refused locally before the request is sent (`hosted_web_search_unsupported`, `native_structured_output_unsupported`). The SDK has no fallback tool to switch to: the terminal already picks the common `web_search` tool when the provider cannot search, and structured output mode is the host's choice at the start of a run.
- A duplicated tool-call id fails closed in `repairToolMessageHistory`, because rewriting a signed assistant turn is unsafe. The request is sent as it is.
