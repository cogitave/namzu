---
"@namzu/sdk": patch
---

Fix `~/.namzu/index.sqlite` becoming "database disk image is malformed" after a Namzu process was killed in the middle of an index write. The next process read the file read-only, could not roll the dead writer's journal back, took the file for "not a database" and renamed a rebuilt one over it, leaving the old journal beside the new file to be played into it. The index version is now read through a writable connection that recovers the journal, only SQLite's corrupt or not-a-database answer starts a rebuild, and a rebuild takes the old file's lock before replacing it. Nothing to change for callers.
