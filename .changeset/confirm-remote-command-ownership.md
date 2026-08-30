---
'@namzu/sandbox': minor
'@namzu/sdk': patch
---

Honor `SandboxExecOptions.signal` in the framed microVM backend through a
reserve-before-admission and idempotent cancellation protocol. Remote execution
now preserves streamed output and terminal signal/truncation metadata, refuses
malformed or trailing terminal frames, and confirms process-group quiescence
before a cancelled sandbox can be reused.

Reject delayed or partial data after the framed terminator, route the public
request-shaped microVM transport method through the same ownership controller,
evict terminal history before refusing live capacity, and retire rather than
signal a numeric process-group id after its leader exits. Teardown calls are
coalesced and Docker retirement now reports success only when removal succeeds;
credential-proxy cleanup still runs on removal failure.

Reserve every command on current HTTP and framed peers, including commands
without a caller signal. Explicitly detected older peers keep legacy no-signal
execution; an ambiguous legacy result or unconfirmed cancellation fences the
handle and retires the whole container, container group, or microVM.
