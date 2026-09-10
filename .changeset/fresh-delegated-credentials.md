---
"@namzu/cli": patch
---

Refresh Anthropic OAuth credentials before cross-provider agent launches and model discovery instead of reusing the startup token. Concurrent launches share serialized renewal and honor credentials removed or rotated by their owner.
