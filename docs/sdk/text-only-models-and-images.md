---
type: Reference
title: Text-only models and images
description: How a conversation that holds an image keeps working on a model that cannot read one.
resource: packages/sdk/src/runtime/query/request-rich-content.ts
tags: [sdk, providers, images, capabilities]
status: stable
generated: { by: process:claude-code, at: 2026-10-19T00:00:00Z }
---

# Text-only models and images

One provider serves models that read images and models that do not. A text-only model refuses the **whole request** when it finds an image anywhere in it, so a single screenshot in the history used to make every later turn fail until the conversation was replaced.

The conversation is never rewritten to avoid this. What changes is the request built for a model that cannot read images.

## What the runtime does

1. **Asks the driver.** `LLMProvider.supportsImageInputFor(model)` answers for one model, where `capabilities.supportsVision` answers for the driver. `false` means the model is known to be text-only; absent or `true` means send images. The Zen driver answers from its catalogue (`inputModalities`). `modelReadsImages(provider, model)` combines both. The retry, idle-timeout and fallback wrappers forward the method (a fallback chain answers for its first member).
2. **Leaves images out of the request.** For such a model, every image in a user attachment or a tool result is replaced by a short text note, for example `[image omitted: the current model cannot read images (image/png, 462 B)]`. The stored messages keep the bytes, so switching to a model that reads images sends them again. The decision is made per request, from the model that request is for, so `/model` and Auto routing take effect on the next turn.
3. **Recovers from a refusal it did not predict.** When a provider answers a request that holds images with a 400 whose text says the model takes text only (for example Zen's `Beam supports text input only. This conversation contains an image.`, or "does not support image input"), the runtime sends the request once more with no images, treats that model as text-only for the rest of the run, and emits one `capability_warning` with `capability: 'vision'`, `contentSource: 'history'` and the `model`. A host that outlives the run (the terminal does) remembers the model and answers `supportsImageInputFor` for it on later turns. A second refusal is an ordinary failure. `isImageInputRefusal` and `isImageInputRefusalMessage` expose the classifier.
4. **Keeps image-only tools away.** `computerUseUnavailableReason(provider, model)` also returns a reason when the model cannot read images, so a host mounts `computer_use` (and `view_image`) as a diagnostic instead of letting the model act on a screen it cannot see. The terminal suspends the computer-use tool for any turn whose model cannot read images.

Tools that only sometimes return an image (a browser screenshot, a tool server) stay available; their image is replaced by the note above and their text result is kept.

## In the terminal

A refused image no longer ends the conversation. The terminal shows one line, "This model can’t read images, so Namzu is leaving pictures out of what it sends. They come back if you pick a model that reads images with /model." If a request still fails for this reason, the message points to `/model` and never to starting a new conversation.
