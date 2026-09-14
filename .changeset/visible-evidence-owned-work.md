---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Project bounded file-evidence references and owned worker status into model requests. A successful write body is referenced only while its complete call input and receipt remain visible and match the conversation's observation fingerprint. Existing disk-drift checks still run before mutations. Observations without content now invalidate an earlier fingerprint instead of carrying it forward.

`FileReadTracker.recordRead` accepts an optional third argument for a successful full-body write's tool-call ID, exposed through the optional `writeCallId` method. The built-in tracker preserves this witness across identical observations and clears it on changed or unknown content. Existing custom trackers remain valid; trackers without the witness do not enable the new file reference projection.

Add `CompletionInbox.describeOwnedWork()` for a non-consuming snapshot of up to sixteen owned tasks, separating scheduler state from delivery to history. The runtime uses it to keep available results visible after operator steering; delivery does not claim that a user-facing synthesis was produced. No automatic relaunch, answer-verification inference or persisted duplicate transcript is added.
