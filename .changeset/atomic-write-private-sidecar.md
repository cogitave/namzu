---
'@namzu/sdk': patch
---

Atomic writes stop sharing one scratch file.

The rename is what makes a write atomic — a reader sees the old file or the
new one, never a half-written one. The sidecar it renames *from* has to be
private to that write, and in seven places it was a fixed `${path}.tmp`.

Two writers of the same record then shared one scratch file: both opened it,
both wrote into it, and the first rename published whatever mixture had
landed while the second renamed a file that was no longer there. That is the
exact failure atomic writes exist to prevent, reached through the mechanism
meant to prevent it.

Not hypothetical for this SDK: the cross-process park and unpark handoff —
one process suspending a run, another resuming it — is a design where two
processes legitimately touch the same records, and it is the feature these
stores exist to serve. One store already picked a private name; the other
seven inherited the fixed one.

- One `atomicWriteFile` in `utils/`, used by the session, thread, run, task
  and memory stores, the retention backend and both migration writers. The
  sidecar carries the process id, a per-process counter and random bytes —
  distinct within a millisecond, within a process, and across hosts sharing
  a network mount.
- It lives in `utils/` rather than `store/` because one of those writers was
  *deliberately* duplicated to avoid an inbound dependency on the store
  layer. That instinct was right, and it is also why that copy kept the
  fixed name after the others were fixed; somewhere everything may depend on
  leaves nothing to duplicate.
- A rename contended by a concurrent writer is retried briefly. Replacing an
  existing file by rename is unconditional on POSIX and not on Windows,
  where a concurrent writer holding the target fails the call for as long as
  the other rename takes — and two processes writing one record is precisely
  what this helper is for. Bounded to five attempts, so a genuine permission
  error still fails immediately instead of hanging.
