---
"@namzu/cli": patch
---

A session never writes generated state into its working directory, and a
session started in the home directory no longer reads the same memory file
twice.

`namzu`, `namzu run`, `namzu run-stream`, `namzu drain` and resident runs
already passed the application home and are unchanged. A session created
without one used to default to `<cwd>/.namzu` for its runs, memory and task
state, and minted a new Project on every launch. It now uses the application
home (`NAMZU_HOME`, else `~/.namzu`) and derives the Project from the working
directory's checkout. Generated memory is always partitioned by Project.

Started in `$HOME` with no `NAMZU_HOME`, the project's `.namzu/MEMORY.md` and
the user's `~/.namzu/MEMORY.md` are one file. It was injected into every
prompt twice, under both headings. It is now read once, as the user memory.
