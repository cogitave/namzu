---
'@namzu/desktop': patch
---

Removing a folder from Trusted folders now waits for the engine when it is saving the same list, and reads the list again first, so a folder the terminal trusted a moment earlier is no longer dropped. The list as it was is kept in `backups/trust.json.backup.<time>` in the Namzu home first, entries Desktop does not show are kept, and a list written by a newer version is shown as unreadable and left alone. Nothing to change on your side.
