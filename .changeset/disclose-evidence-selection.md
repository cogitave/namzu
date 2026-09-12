---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Automatic evidence recall now reports `omittedPassages` when eligible distinct
records do not fit the selected passage count or context size. Bounded
`additionalEvidence` addresses let archive tools recover withheld text;
`omittedAddresses` reports addresses which also could not fit. The original
scope checks and character ceiling remain in force.

The context can now retain an omission notice and read address even when no
whole excerpt fits. `incomplete` continues to describe source traversal, rather
than implying that every matched record was presented. In the CLI these
addresses work with the existing `read_conversation` tool. This corrects hidden
selection loss without changing the recall opt-in or adding model calls to the
retrieval hook itself.
