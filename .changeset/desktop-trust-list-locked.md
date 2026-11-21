---
'@namzu/desktop': patch
---

Removing a folder from Trusted folders now waits for the engine when it is saving the same list, and reads the list again first, so a folder the terminal trusted a moment earlier is no longer dropped. The list as it was is kept in `backups/trust.json.backup.<time>` in the Namzu home first, entries Desktop does not show are kept, and a list written by a newer version is shown as unreadable and left alone. When the list cannot be read, Trusted folders now offers **Start a new list**: it keeps the old file in `backups/trust.json.corrupted.<time>` first and says where, and trusting a folder in the meantime says to use it. A lock left by a process that has exited, or an empty one, no longer blocks the list. Nothing to change on your side.
