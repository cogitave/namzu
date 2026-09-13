---
"@namzu/sdk": patch
"@namzu/cli": patch
---

When optional conversation query planning finds competing referents, preserve
that interpretation for the main model instead of silently skipping recall.
A temporary note carries validated quotes and asks the model to clarify if
needed; it is labelled as a fallible interpretation, not historical evidence.
No subject is selected for automatic retrieval in this case. The note shares
the existing context allowance and cancellation, and new operator input clears
the cached interpretation. SDK defaults and CLI configuration keys are unchanged.
