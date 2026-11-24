---
"@namzu/sdk": minor
---

A picture the person attached to a message, sent to a model its driver knows reads text only (`supportsImageInputFor(model)` is `false`), is now refused before anything is sent (`capability_unavailable`: "Model 'x' does not accept image input. Select 'y' or remove the images.") instead of being left out with a warning, so the model no longer answers about a picture it never saw. A driver can name the model to select with the new optional `LLMProvider.imageModelFor(model)`; the retry, idle-timeout, fallback and window-suffix wrappers forward it. Images a tool returned (`view_image`, `generate_image`, screenshots) are still left out quietly. To keep the old behaviour, a host drops the attachment itself before calling `query()`.
