---
"@namzu/cli": major
---

`#note` and `/memory add` now save a typed memory file instead of appending a bullet to `<project>/.namzu/MEMORY.md`.

What changes for you:

- **Where a note goes.** `#note <text>` and `/memory add <text>` write `<name>.md` (type `project`; `/memory add --type user|feedback|project|reference <text>` picks another) into the project's stored memory — `<NAMZU_HOME>/memory/<project-id>/` by default — the same files the model's `save_memory`, `search_memory` and `read_memory` use. The terminal names the file. `/memory --user add <text>` is unchanged and still appends to `~/.namzu/MEMORY.md`. To keep writing a note into the curated project file, edit `<project>/.namzu/MEMORY.md` directly; it is still read into every turn.
- **Old notes are copied only when you ask, and your file is never changed.** The project's curated `MEMORY.md` is not rewritten, at launch or ever: nothing can tell a bullet `#note` appended from one you wrote. When it holds top-level bullets, the launch says how many, once per curated file, and `/memory import-notes` copies every top-level bullet (its first line) into a typed `project` memory, skipping any already stored — by an earlier import, a `#note` with the same text, or a copy you archived — so running it twice creates no duplicates. The bullets stay curated text in every turn until you delete them from the file yourself.
- **A one-time move of the JSON store on first launch.** An earlier JSON memory store (`index.json` + `content/`) in the same directory is imported with its ids and renamed `*.migrated`; the launch says so. A record too large for a memory file (over 256 KiB) is not imported and is named, with the retired file that still holds it.
- **The prompt.** Every turn carries a `## Stored memories (index)` section — one line per memory you or the model saved, at most 200, your `feedback` and `user` memories first. What the run promoter (or `compaction.consolidate`) writes after a run is searchable but not listed, so a run's record does not change the next turn's system prompt — and the curated sections are renamed `## Curated memory (all projects)` and `## Curated memory (this project)` (they were `## Durable memory` and `## Project memory`). Anything that matched those headings in a captured prompt must match the new ones.
- **`/memory show`** lists stored memories' index lines before the curated files, and what runs recorded on their own in a separate `Recorded by runs (N)` section, so those records are visible even though the prompt's index leaves them out.
- **Note names are short.** A note's file is named after its first words, at most 32 characters, so its index line keeps room for the note itself.

Nothing in the CLI's library exports changed.
