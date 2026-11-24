---
"@namzu/deepseek": patch
---

`DeepSeekProvider` now answers `supportsImageInputFor(model)`: true only for the models it sends images to, false for the text-only ones such as `deepseek-chat`. A host that asks before sending a picture (a generated image, `view_image`) no longer makes a request the driver then refuses with "does not accept image input", which ended the turn.
