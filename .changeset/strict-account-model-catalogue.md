---
"@namzu/anthropic": minor
---

Add `AnthropicProvider.listModelsStrict(signal?)` for hosts that need the
account's actual Models API rows and errors. Empty responses remain empty and
authentication/network failures reject instead of returning bundled models.
Pagination includes later account rows, preserves caller cancellation across
pages, and rejects oversized catalogues rather than silently truncating them.
Use it to present current account availability without treating an offline
catalogue as proof of access. Existing `listModels` fallback behavior is unchanged.
