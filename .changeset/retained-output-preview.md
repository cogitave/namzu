---
"@namzu/sdk": minor
"@namzu/cli": major
---

Separate the SDK's overflow threshold from the size of an authenticated retained-output preview. `query`/`resumeRun` and `ReactiveAgent` accept `retainedToolPreviewChars`; unset or zero preserves the existing behavior. A shorter preview is used only after full host text and its integrity manifest are saved. Storage failure keeps the ordinary text budget. Rich blocks and independently supplied model text keep their existing handling.

Recorded CLI conversations now default to at most 4,000 characters for these retained overflow previews, previously up to 40,000. The 40,000-character spill threshold and ordinary smaller results are unchanged. Set `compaction.retainedToolPreviewChars: 0` in CLI configuration to retain the previous preview size. This applies to new tool results in ordinary turns and resumed runs, without rewriting existing history. Stateless sessions and delegated workers retain their existing defaults.
