---
"@namzu/sdk": patch
---

Loop reliability (ses_015): heal dangling tool call/result pairs on resume, replay, and cancellation via the new `repairDanglingMessages` (drop orphans, synthesize missing results, canonicalize placement) and `prepareResumeMessages`; replay repairs after mutations; the proactive compaction cut now routes through `findSafeTrimIndex` so it cannot sever a tool pair. Adds a typed provider error taxonomy (`ProviderRequestError`), model-call retry with jittered backoff, reactive context-overflow recovery, AbortSignal threading to providers, and `finishReason: 'length'` handling.
