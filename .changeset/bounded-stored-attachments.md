---
'@namzu/sdk': major
---

Stored attachment resolution is now reachable through `runAgent`, `ReactiveAgent`, `SupervisorAgent`, routed delegates, and directory-derived configs. Pass the owning `AttachmentStore` through `runAgent({ attachmentStore })` or `AgentInput.attachmentStore`.

The materialization phase now has a finite one-minute default. Configure `attachmentResolveTimeoutMs` on the run or agent boundary, or set it to `0` to retain the previous unbounded wait. Direct `resolveAttachment` and `resolveAttachments` callers can use `options.timeoutMs`. A deadline rejects with `AttachmentResolutionTimeoutError`; missing, mismatched, or late attachments are never silently dropped.
