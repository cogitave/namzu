---
'@namzu/cli': minor
---

namzu reads the project's own `AGENTS.md` and follows it

Until now every word namzu injected into its system prompt was about the user
and global to the machine — its identity block, `~/.namzu/USER.md` and
`~/.namzu/MEMORY.md`. Nothing about the repository it was standing in ever
reached the model. A project that had written down how it wants code written
got an agent that could not see it, and the only way to tell it was to paste
the file by hand at the start of every session.

The working directory's `AGENTS.md` is now loaded, along with the one in every
directory up to the repository root — the first with a `.git`, which is a file
in a worktree and a directory in a clone, and both count. They are ordered
outermost first, so a package-level file has the last word over a
repository-level one. Sub-agents get them too: a delegated task writes the same
code in the same repository and is bound by the same rules.

Nothing to configure and nothing to opt into. If your project has no
`AGENTS.md`, the prompt is byte-for-byte what it was.

What you will see change: namzu names the files it loaded — a line under the
connect banner in the TUI, and the same line on stderr from `namzu run`,
alongside the provider line. Nothing on stdout moves, so a script that pipes
the answer is unaffected. `run-stream` loads the files identically but does not
yet announce them on its event stream.

A file is read up to 32,000 characters, and when one is cut the agent is told
so in place, with the number of characters dropped. A truncated policy is never
presented as a whole one.

Read off the working directory means read off whatever directory you pointed
at, including with `namzu run --cwd`. The text is injected after namzu's own
identity and rules and is labelled as the project speaking, so a file cannot
redefine the agent or talk it out of what it was told — but treat an
`AGENTS.md` from a repository you do not trust the way you would treat its
build script, which namzu will also run.
