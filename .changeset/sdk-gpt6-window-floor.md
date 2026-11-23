---
'@namzu/sdk': patch
---

The model-name table now knows the gpt-6 family (`gpt-6.2`, `gpt-6`) at 258,000 tokens, an unverified floor, so those models no longer fall to the 128,000-token guess when the provider reports no window; a provider's own number still wins. A gpt-6 model now compacts later than before (at about 225,000 tokens instead of 95,000); to keep the old trigger, set `compaction.contextWindowTokens` to `128000`.
