---
'@namzu/sdk': patch
---

An `edit` or `write` that cannot run (an edit whose text is not in a file never read, an overwrite of a file never read, a file that changed since it was read) and a `bash` command that opens with a long `sleep` are refused before the permission dialog, with the same message as before, so you are no longer asked to approve a call that fails the moment you say yes. A request you stopped before the model replied is marked `[Request interrupted by user]` in what the model reads, so the next message is not mistaken for a second part of it, also after resuming the conversation.
