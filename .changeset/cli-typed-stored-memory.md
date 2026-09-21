---
"@namzu/cli": major
---

`#note` and `/memory add` now save a typed memory file instead of appending a bullet to `<project>/.namzu/MEMORY.md`.

What changes for you:

- **Where a note goes.** `#note <text>` and `/memory add <text>` write `<name>.md` (type `project`; `/memory add --type user|feedback|project|reference <text>` picks another) into the project's stored memory — `<NAMZU_HOME>/memory/<project-id>/` by default — the same files the model's `save_memory`, `search_memory` and `read_memory` use. The terminal names the file. `/memory --user add <text>` is unchanged and still appends to `~/.namzu/MEMORY.md`. To keep writing a note into the curated project file, edit `<project>/.namzu/MEMORY.md` directly; it is still read into every turn.
- **A one-time move on first launch.** The project's curated `MEMORY.md` gives up its single-line top-level bullets as typed memories; the file as it was is kept as `MEMORY.md.before-typed-memory`, and headings, prose and multi-line notes stay. An earlier JSON memory store (`index.json` + `content/`) in the same directory is imported with its ids and renamed `*.migrated`. The launch that moves something says so. Bullets you write into the curated file afterwards stay there.
- **The prompt.** Every turn carries a `## Stored memories (index)` section — one line per memory, at most 200 — and the curated sections are renamed `## Curated memory (all projects)` and `## Curated memory (this project)` (they were `## Durable memory` and `## Project memory`). Anything that matched those headings in a captured prompt must match the new ones.
- **`/memory show`** lists stored memories' index lines before the curated files.

Nothing in the CLI's library exports changed.
