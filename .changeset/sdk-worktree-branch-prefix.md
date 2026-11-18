---
'@namzu/sdk': minor
---

`GitWorktreeDriver` takes an optional `branchPrefix` (default `namzu`, so its branches are unchanged): a new worktree's branch is `<branchPrefix>/<label>`. The prefix is one safe component of up to 40 characters and the constructor refuses any other. A worktree whose branch carries a different valid prefix is still owned, because its path and Git's registration of that exact branch decide ownership.
