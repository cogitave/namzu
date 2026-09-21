---
"@namzu/cli": patch
---

A session never writes generated state into its working directory, and a
session started in the home directory no longer reads the same memory file
twice.

Every entry point — `namzu`, `namzu run`, `namzu run-stream`, `namzu drain`
and resident runs — keeps its sessions, memory and task state under the
application home (`NAMZU_HOME`, else `~/.namzu`), in the working directory's
`projects/<slug>/`, and files them under that directory's one Project.
`<cwd>/.namzu` is only read, for the agents, skills, commands, plugins and
`MEMORY.md` you keep there.

Started in `$HOME` with no `NAMZU_HOME`, the project's `.namzu/MEMORY.md` and
the user's `~/.namzu/MEMORY.md` are one file. It was injected into every
prompt twice, under both headings. It is now read once, as the user memory.
