---
"@namzu/cli": minor
---

File checkpoints. Before the session's `edit` or `write` tool changes a file, the file is recorded as it was — or as absent — once per file per turn. `/restore` lists the turns that changed files; `/restore N` puts every file back to before turn N, undoing N and every later turn (changed files rewritten, created files removed), and tells the model what was put back. Shell and sub-agent writes are not covered, and the records are dropped when the session closes.
