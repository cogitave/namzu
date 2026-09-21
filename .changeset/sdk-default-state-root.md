---
"@namzu/sdk": major
---

With no `pathBuilder`, generated runtime state no longer goes to
`<workingDirectory>/.namzu`. It goes to the new `defaultStateRoot()`:
`NAMZU_STATE_DIR` when set, else `$XDG_STATE_HOME/namzu` or
`~/.local/state/namzu` on Linux, `~/Library/Application Support/namzu/state` on
macOS and `%LOCALAPPDATA%\namzu\state` on Windows. That covers `query`,
`drainQuery`, `runAgent`, the agents built on them, and `openTokenBudget`.
The old default wrote a `.namzu/` into whatever directory the agent worked in,
and into the CLI's own `~/.namzu` when that directory was `$HOME`.

**What changes for you.** Runs, checkpoints, token ledgers and crash dumps of a
host that passes no `pathBuilder` are written to, and resumed from, the new
root. Runs already under `<workingDirectory>/.namzu` are not moved. To keep
the old location, pass
`pathBuilder: new DefaultPathBuilder(join(workingDirectory, '.namzu'))`, and
pass it to every call that resumes those runs. Two runs with the same explicit
`projectId`, `sessionId` and `runId` from different working directories now
share one run directory; give them a `pathBuilder` each to keep them apart.

`OpenTokenBudgetOptions.workingDirectory` is deprecated and ignored: it only
chose the old default root. Pass `pathBuilder` instead.
