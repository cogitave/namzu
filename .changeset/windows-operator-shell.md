---
"@namzu/cli": patch
---

Fix operator `!command` execution on native Windows by using its platform shell instead of `/bin/sh`. Preserve `/bin/sh` on POSIX, decode split UTF-8 output, refuse pre-aborted launches, and share host process-tree cancellation. Transcript output remains capped at 20,000 characters; a command is also stopped if either stream exceeds 80,000 bytes. Process-start failures now remain visible in the transcript.
