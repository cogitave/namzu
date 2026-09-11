---
"@namzu/cli": major
"@namzu/sdk": minor
---

The CLI now requires Node.js 22.13+ and stores session metadata in
`NAMZU_HOME/state/sessions.sqlite`, with artifacts directly under
`NAMZU_HOME/sessions/<sessionId>/`. It no longer creates or reads a `projects/`
runtime tree. Generated memory remains isolated under `memory/<projectId>/`,
and resident state moves to `residents/<projectId>/<agent>/`.

This changes the default persisted CLI format. Existing project trees are left
untouched and are not imported automatically. Back up the original application
home and retain the older CLI to access its conversations, generated memory
and residents. Credentials, preferences and authored configuration keep their
locations. Update custom artifact readers to the new session paths.

The SDK adds the optional `SqliteSessionStore` driver and an exact `directory`
option for `DiskMemoryStore`. Existing SDK drivers, formats and defaults remain
unchanged; SQLite is loaded only when its driver is used.

`history` now accepts real conversation UUIDs as well as host keys, and with no
key reads the most recent workspace conversation as its help documents.
