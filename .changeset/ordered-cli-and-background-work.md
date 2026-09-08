---
"@namzu/cli": major
---

CLI built-in `bash`, `write` and `edit` calls now act as execution barriers within
a model-generated batch. Earlier calls settle before them and later calls wait
for them, instead of concurrency-safe reads overlapping those mutations. SDK
embedders can retain the old scheduling by leaving `executionBarrier` unset;
the CLI deliberately uses ordered mutation boundaries. Background shell jobs
still release the boundary after launch, not after the job finishes.

Add opt-in `Agent.run_in_background` and `send_message` for queued corrections
to owned running children. Existing blocking delegation remains the default;
finished tasks are not restarted. Add direct, session-only host model selection
for standalone `/model ID` and recognized model-change requests, with model and
effort previews in the composer. Mixed work remains a model prompt.
