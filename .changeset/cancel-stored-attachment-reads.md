---
'@namzu/sdk': minor
---

Bind stored image and document resolution to the run's caller signal. A pre-cancelled run now starts no attachment-store or provider work, and a store that ignores cancellation can no longer hold the run open or publish bytes after authority is withdrawn. Cancelled runs retain the unresolved attachment references in their durable messages. Canonical resumes also retain the selected checkpoint's history and usage without rereading that checkpoint after cancellation.

Custom `AttachmentStore` implementations may accept the new optional `AttachmentOperationOptions` argument on `get` and should use its signal to stop owned I/O. Existing one-argument implementations remain compatible.

`resumeRun` now refuses contradictory run, session, topic, project, tenant, or explicit parent attribution before provider work instead of allowing checkpoint history to cross those boundaries. Its selected checkpoint also supplies the trace parent for a cancelled cross-process resume without a second checkpoint read.
