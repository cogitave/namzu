---
'@namzu/sdk': patch
---

Allow host-triggered whole-history compaction to establish a retained summary floor for user/assistant-only conversations. Compaction now preserves every retained message together with the user boundary and complete tool exchange needed for a provider-valid turn, and manual whole-history and region passes decline before provider work when those survivors leave nothing to shed.
