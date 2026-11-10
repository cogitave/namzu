---
'@namzu/cli': minor
---

A turn that changed files, or ran a check that failed, now ends with one plain line saying what a recognised check established, for example `Changed 4 files · checked: pnpm test passed, nothing changed since` or `Changed 4 files · not checked`; a turn that changed nothing prints nothing. `namzu exec --output-format json` has the record as `outcome` on its result and `namzu exec --json` puts it on the `done` line. A delegated agent's result names the record in one line after the agent's own words. Shell commands are seen when the tools run in a git working folder; in a folder git cannot read, with a sandbox that works in a copy of its own, or in an isolated child worktree, only the edit tools are.
