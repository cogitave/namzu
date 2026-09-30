---
"@namzu/sdk": patch
---

Preserve the runtime's completed tool presentation in ACP updates. File diffs and terminal results now reach ACP clients with the real result data instead of falling back to a generic text label. Older event producers without a presentation retain the existing fallback.
