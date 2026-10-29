---
"@namzu/sdk": patch
---

Keep a delegated worktree branch when it advances between inspection and cleanup. Branch deletion now compares the recorded starting commit under Git's ref lock, so cleanup cannot delete a concurrently updated branch.
