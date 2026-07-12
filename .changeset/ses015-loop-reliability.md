---
"@namzu/sdk": patch
---

Loop reliability (ses_015): heal dangling tool call/result pairs on resume, replay, and cancellation via the new `repairDanglingMessages` (drop orphans, synthesize missing results, canonicalize placement, keep one result per call id) and `prepareResumeMessages`; replay repairs after mutations; the proactive compaction cut now routes through `findSafeTrimIndex` so it cannot sever a tool pair. Adds a typed provider error taxonomy (`ProviderRequestError`), model-call retry with jittered backoff, reactive context-overflow recovery, AbortSignal threading to providers, and `finishReason: 'length'` handling.

**Retry is on by default** — up to 3 attempts per model call, and vendor-internal retries are disabled so that cap is the real bound on physical requests. This changes request count, cost, and how long a failing call takes to give up. Disable it with `retry: { enabled: false, maxAttempts: 1, … }`. The SDK's ancillary calls (compaction verifier, task router, advisory) carry their own bounded budget and do not read `runConfig.retry`. See the [0.5 migration guide](https://docs.namzu.ai/migration/0.5).

**A model call is now bounded by the run deadline while in flight**, not merely between attempts. A provider that hangs can no longer hold a run past its `timeoutMs`; the run stops as `timeout`. For an adapter that cannot be cancelled (Ollama's non-streaming path), the request may still be in flight — the loop stops waiting for it, and its late response is discarded rather than acted on.
