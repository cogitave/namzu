---
'@namzu/sdk': minor
---

Shell commands (host, background jobs and the local sandbox) now find `node` when the user's PATH has none: the directory of the running node binary is added to the END of their PATH, so a `node` you installed still wins and nothing is reordered. New exports `withNodeOnPath` and `nodeDirectoryToAppend`. A command that exits 127 because node, npm, npx, pnpm, python, cargo or rustc is missing ends its output with a short line saying how to look it up once. A compaction now puts back the shell commands that worked (`### Working commands`), leaves the worked-example sections out of a restored skill, and the summary model is asked to keep how tests, builds and runtimes are run. A new turn no longer writes the compaction summary into the session log again when the log already holds it.
