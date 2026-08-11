---
'@namzu/sdk': minor
---

The MCP server has a transport, and a failing post-checkout hook no longer discards a good worktree

Two independent gaps, both found by studying how a comparable product solves the same problems. Neither is a port: the code here is namzu's, and in both cases the missing piece was smaller than it looked because the machinery already existed.

**`MCPServer` had no way to run.** It is a complete implementation — `initialize`, `tools/list`, `tools/call`, resource and prompt providers — and nothing anywhere constructed one, because every transport in `connector/mcp/` is the *client* side: they connect this process to somebody else's server. `ServerStdioTransport` is the other end, so somebody else's client can drive namzu.

Stdio first, deliberately. The client spawns the server as a child process, so there is no port, no bind address, and no inbound authentication question to answer wrongly. Note that stdout belongs to the protocol on this transport — a stray write corrupts the stream. This repository's logger writes to stderr, which is what makes it safe.

**`GitWorktreeDriver.create` trusted the exit code.** `git worktree add` runs the repository's post-checkout hook *after* the checkout completes, so a hook that fails or is killed by a timeout reports failure over a worktree that is finished and usable. Trusting the status threw that worktree away and leaked it — the path stays registered, so the next attempt fails differently, with "already exists".

`create` now checks the repository when the command reports failure, and accepts only a worktree registered under this exact path carrying the branch this call asked for. A registered path alone proves nothing: it can be a half-finished checkout or one somebody else owns, and those two are indistinguishable from here. Any error while checking counts as a failure, because this runs on a path that has already gone wrong once.

No behaviour changes for a `create` that succeeds — the check runs only on the failure path.
