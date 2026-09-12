---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Expose optional `PrepareStepContext.captureRunEvidence(maxReadBytes?, signal?)`
for authenticated text from the current invocation's writer. It rejects local
or run cancellation and settled invocations; unsupported stores return
`undefined`. Automatic evidence recall forwards this capability with its own
deadline and revokes new captures when the recall pass ends.

With `compaction.recallEvidence: true`, recorded CLI turns now recall missing
observations from the current run, including after compaction. Up to two live
pages share the existing four-page, 8 MiB read ceiling with earlier runs;
explicit conversation tools still handle further pages and exact full text.
The default remains off. Captured observations describe the past and do not
establish current workspace contents or replay a tool action.
