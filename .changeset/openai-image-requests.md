---
"@namzu/openai": minor
---

Add `requestCodexImage`, `CodexImagesError` and the constants around them: one call that generates or edits an image through the subscription plan route (`images/generations`, `images/edits`) with the plan's headers, reads the first image, tells a GIF from a PNG, and reports a spent image quota with its reset time. Nothing existing changes; the Responses client now takes its shared headers from the same helper.
