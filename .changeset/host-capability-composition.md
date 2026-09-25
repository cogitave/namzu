---
'@namzu/sdk': minor
---

Add `defineCapability` and `dynamicCapability` for reusable host-authored behavior passed to `runAgent({ capabilities })`. A capability can contribute toolsets, instructions, prompt contributions, input and output guardrails, and per-run model settings. Existing `runAgent` calls need no migration.
