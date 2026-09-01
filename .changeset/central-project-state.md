---
'@namzu/cli': major
'@namzu/sdk': minor
---

Move new CLI-generated sessions, runs, memory and task state into the Project bound to the canonical working directory below `NAMZU_HOME` (default `~/.namzu`). Existing valid project-local state remains in use; corrupt or split histories now refuse and name the read-only inventory command instead of silently opening a different history. Project-local `.namzu` directories are reserved for authored commands, plugins and skills.

High-level SDK agent configs now accept an exact `PathBuilder`, and disk-backed Project root bindings are tenant-scoped, immutable and safe under concurrent creation. Existing callers that omit `pathBuilder` retain their prior layout.
