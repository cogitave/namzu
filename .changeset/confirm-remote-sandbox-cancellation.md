---
'@namzu/sandbox': minor
'@namzu/sdk': patch
---

HTTP-container sandbox commands now honour `SandboxExecOptions.signal` through
an acknowledged execution lease and a separately bounded cancellation request.
Rebuild local worker images and publish a new standby-pool profile revision
before passing a signal; older workers are refused instead of leaving the
remote command running behind an aborted request. Calls without a signal keep
the legacy one-request protocol, and the framed microVM backend remains
unchanged. Stalled result observation is bounded, unconfirmed termination
retires the worker, and confirmed termination with incomplete output is
reported distinctly.
