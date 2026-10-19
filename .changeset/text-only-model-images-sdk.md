---
"@namzu/sdk": minor
---

A conversation that holds an image no longer dies on a model that cannot read one. Nothing breaks and nothing needs changing: where the old behaviour was a hard provider refusal, the request now goes out with each image replaced by a short text note (the stored history keeps the bytes). New optional `LLMProvider.supportsImageInputFor(model)`, `modelReadsImages(provider, model)`, `isImageInputRefusal` and `isImageInputRefusalMessage`; a provider that answers a request holding images with "text input only" or "does not support images" is retried once without them and a `capability_warning` with `contentSource: 'history'` and `model` is emitted. `computerUseUnavailableReason` takes an optional model, and `capability_warning.contentSource` gains `'history'`: a switch over it that assumed only `'tool-result'` needs a default arm.
