---
'@namzu/sdk': patch
'@namzu/cli': patch
---

Propagate run cancellation through every plugin hook and preserve cancellation
when it occurs before the iteration loop. Hook code now receives a signal that
combines the run lifetime with its hook deadline, and a hook that ignores that
signal can no longer keep the run waiting.

Make CLI session shutdown cancel and settle in-flight sends, manual compaction,
and durable resumes before external tool servers are closed. Calls made after
session close now refuse before starting provider work.
