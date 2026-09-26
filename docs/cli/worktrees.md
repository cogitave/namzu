---
type: Reference
title: Managed Git worktrees
description: Create separate checkouts, copy a settled conversation into one, and reopen its project from the CLI or TUI.
resource: packages/cli/src/integrations/worktrees/managed.ts
tags: [cli, git, worktrees, sessions]
status: stable
---

# Managed Git worktrees

`namzu worktree` creates separate Git checkouts under the current repository's
Namzu state directory. It works from the main checkout or a linked checkout.
Each checkout has its own Project and conversation history, so a conversation
from one checkout does not silently appear in another checkout's `/resume` list.

```sh
namzu worktree create review
namzu worktree list
namzu worktree resume review
```

`create [name]` starts a branch named `namzu/<name>` at the **committed HEAD of
the checkout where you run it**. A name uses lowercase letters, digits and
hyphens. When omitted, Namzu generates one. If the source checkout has
uncommitted files, they stay there; the new checkout starts from committed
files, and the command says that explicitly.

`list` shows only registered checkouts whose path and branch match Namzu's
managed root. It marks a checkout with uncommitted files. A Git worktree made
elsewhere, or an unrelated directory placed under the managed root, is not
offered as a target.

## Continue a conversation in a separate checkout

```sh
namzu worktree fork <conversation-id> investigation
namzu worktree resume investigation
```

`fork` first requires a nonempty conversation with no open turn. It creates a
worktree from the current checkout's HEAD, then copies the settled message
history into a **new conversation in the new Project**. The original remains
in the source Project and the two histories diverge. This copies conversation
messages, not uncommitted files, goals, queued prompts or active tool calls.
The command prints the new conversation ID and a command to open it.

`resume <name> [conversation-id]` opens the selected managed checkout in the
interactive CLI. With no ID, it selects that checkout's latest nonempty
conversation; if none exists, it starts a fresh conversation there. An explicit
ID must belong to that checkout. In a pipe or other noninteractive terminal,
it prints the checkout and a copyable open command instead.

In the TUI, `/worktree list`, `/worktree create [name]`,
`/worktree fork [name]` and `/worktree resume <name>` offer the same managed
checkouts. The TUI prints a command to open the other checkout in a new
terminal. It keeps the current screen in its current checkout; switching its
working directory while a session is live would leave its project settings and
tools bound to the previous directory.

Namzu never removes a managed worktree automatically. A checkout may contain
uncommitted files or commits that exist nowhere else. Inspect its state before
using Git's ordinary, non-forced `git worktree remove <path>` yourself; that
command does not delete the branch.

The `Agent` tool can also create one managed checkout per delegated child with
`workspace: "worktree"`. Its generated branch and path appear in the child's
result and in `namzu worktree list`. That child starts from the selected
checkout's committed HEAD and works inside the new checkout. See
[Delegated work](delegated-work.md) for the launch and retention behavior.
