---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add persistent Pal identities, immutable profile revisions and an SDK runtime
that requires an explicitly provided virtual computer before execution. Hosts
can retain one warm computer per Pal, serialize active conversations, enforce
current pause state and retry failed computer cleanup without losing ownership.

Add `namzu pal list/create/show/update/pause/resume/chat` and desktop host Pal
methods. Pal conversations pin a saved profile and bind exactly one Pal in their
session log. File, shell and computer tools run in the Pal guest, with no host
folder, host browser or host plugin fallback. The local computer image and engine
must be set up explicitly before chat can execute.
