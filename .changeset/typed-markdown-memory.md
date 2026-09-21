---
"@namzu/sdk": minor
---

Memories can be typed and kept as one Markdown file each.

- `MarkdownMemoryStore({ directory })` implements `MemoryStore` with one `<name>.md` per memory (YAML frontmatter `name`, `description`, `type`, `status`, `createdAt`, `updatedAt`, `tags`, then the body) and a generated `MEMORY.md` index, one line per active memory. It keeps `DiskMemoryStore`'s guarantees: the shared operation lock, atomic private (0600) writes, and refusal — naming the file — of anything it cannot read. `readIndex({ maxLines })` renders the index for a prompt, capped at 200 lines by default with a note pointing to `search_memory`; `importRecord` moves records in from another store idempotently by id. While a `DiskMemoryStore` `index.json` sits in the same directory, every other operation is refused until its records are imported and the index moved aside.
- `MemoryIndexEntry`, `CreateMemoryParams` and `UpdateMemoryParams` gain optional `name`, `description` and `type` (`user | feedback | project | reference`). All three shipped stores persist them, and refuse a `name` another record holds with the new `MemoryNameConflictError`, which names that record. Omitting the fields behaves exactly as before; an existing store, index or custom `MemoryStore` needs no change.
- `save_memory` and `update_memory` take `name`, `type` and `description`; a taken name returns a failed tool result pointing at `update_memory`. `read_memory` accepts a name as well as an ID, reports the memory's age, and resolves `[[name]]` links. `search_memory` lines show name, type and age.
- `createMemoryRecallStep` adds `name`, `type` and, for a record older than `ageNoticeAfterMs` (default one day), an `age` field, and then ends its block with `MEMORY_VERIFY_NOTICE`. A block of records updated within the day is unchanged apart from the new fields.
- New helpers: `renderMemoryIndex`, `memoryIndexLine`, `memoryLinkNames`, `describeMemoryAge`, `slugifyMemoryName`, `isMemoryName`, `isMemoryType`, `assertMemoryType`, `MEMORY_TYPES`, `MEMORY_INDEX_MAX_LINES`, `MEMORY_INDEX_LINE_MAX_CHARS`.
- `DiskMemoryStore.get` and `getRecord` no longer return the file's `schemaVersion` stamp as a field of `MemoryContent`, which the type never declared.

Nothing is removed or renamed. A host that wrote a second record under the same title through `save_memory` still can: names are only enforced when a caller supplies one.
