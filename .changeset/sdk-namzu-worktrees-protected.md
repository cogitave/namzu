---
'@namzu/sdk': patch
---

A write into a project's `.namzu/worktrees/` is now asked about like any other
write under `.namzu`. The exemption dates from when delegated work kept its
worktrees there; they live in the Namzu home now
(`projects/<slug>/worktrees/`), and a write inside one is still judged against
that worktree's own root, so delegated work asks no more often than before.
Only a write you make into an old `.namzu/worktrees/` folder now asks first.
