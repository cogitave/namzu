---
'@namzu/cli': patch
---

On Windows, an extension that records in the background now starts at sign-in. The sign-in launcher ran `extension daemon start`, which asked the already-running task to run again and so never started the runner; it now runs the runner itself. Nothing to do: Namzu rewrites the launcher the next time it starts.
