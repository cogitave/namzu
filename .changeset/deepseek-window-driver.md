---
'@namzu/deepseek': minor
---

`deepseek-flash`, the vendor's current Flash id, is now in the catalogue and accepts images; `deepseek-v4-pro` stays text only, and `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` stay as the legacy names the vendor still serves. The driver reads `context_window` and `max_output_tokens` from the models endpoint when the vendor returns them and falls back to the documented 1,000,000 / 384,000, so compaction is measured against the real window instead of a 64,000-token guess. An image sent to a model that does not take one now names `deepseek-flash` in the error.
