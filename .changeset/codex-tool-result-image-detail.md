---
"@namzu/openai": patch
---

The Codex (Responses) driver sends images returned by tools with `detail: "high"` instead of `"auto"`. With `auto` the backend could pick the 512-pixel `low` view of a screenshot, so a model answered in coordinates of an image the tool never produced. Images the user attaches still go with `auto`. No change is needed on your side.
