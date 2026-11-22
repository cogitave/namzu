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

`create [name]` starts a branch named `<prefix>/<name>` (the prefix is `namzu` unless
you set it, see [Settings for worktrees](#settings-for-worktrees)) at the **committed HEAD of
the checkout where you run it**. A name uses lowercase letters, digits and
hyphens. When omitted, Namzu generates one. If the source checkout has
uncommitted files, they stay there; the new checkout starts from committed
files, and the command says that explicitly.

`list` shows only registered checkouts whose path and branch match Namzu's
managed root. It marks a checkout with uncommitted files. A Git worktree made
elsewhere, or an unrelated directory placed under the managed root, is not
offered as a target.

## Settings for worktrees

Four rows in Settings (Projects, under *Worktrees* and *Conversations*), and the same keys in
`~/.namzu/config.yaml` or through `namzu config set`, shape new worktrees. They are read from your own
file and the managed file only: a project file cannot set `worktrees`, so a repository cannot choose
where Namzu writes checkouts or what their branches are called (a project file that tries is ignored,
with a notice). A change reaches the next worktree made; none that exists is moved or renamed.

| Key | What it does |
| --- | --- |
| `worktrees.branchPrefix` | The start of a new worktree's branch, as `<prefix>/<name>`. Default `namzu`. One to 40 letters, digits, dots, underscores or hyphens, not starting with a dot or hyphen, not ending in a dot or `.lock`, no `..`, and not `main`, `master` or `HEAD`; a refused prefix says which rule it broke. A worktree made under an earlier prefix keeps its branch and is still found, because Git, not the prefix, vouches for the branch. |
| `worktrees.location` | An absolute folder where new worktrees are made, one folder per project inside it. Absent means the project's own folder under the Namzu state directory (today's place). The folder must exist and be writable: it is checked when saved and again when a worktree is made, and a folder that has gone is refused by name, never replaced silently by the default. Worktrees already made stay where they are, and `namzu worktree list` shows only those under the folder in force. |
| `worktrees.sparseFolders` | Folders of the project, written from its top (`src/app`), that a new worktree holds. Namzu runs `git sparse-checkout set --cone` in the new checkout: the files at the top of the project and those folders stay, everything else leaves the folder though it stays in the branch. A folder that is absolute, leaves the project (`..`) or holds a wildcard is refused. If Git cannot narrow the checkout (an old Git, for instance), the worktree is still made and kept in full, and a notice says so. A worktree a `worktree_create` hook made is not narrowed. |
| `attribution` | Not a worktree setting but listed here with the Git rows of Settings: text the agent ends commit messages and pull request descriptions with. Empty by default. See [Reply style and commit text](turn-notes.md#reply-style-and-commit-text). |
| `cleanupPeriodDays` | Days a conversation may sit unchanged before it is removed from this computer (default 30, minimum 1). See [Keeping conversations](session-storage.md#keeping-conversations-cleanupperioddays). |
| `promptHistory` | `false` stops the terminal app writing `history.jsonl`. See [Prompt history](session-storage.md#prompt-history-historyjsonl). |
| `archiveInactive` | `never` (default), `1d`, `7d` or `30d`. See [Archiving idle conversations](session-storage.md#archiving-idle-conversations). |

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

Namzu never removes a worktree that `namzu worktree create` or `fork` made. A
checkout may contain uncommitted files or commits that exist nowhere else.
Inspect its state before using Git's ordinary, non-forced
`git worktree remove <path>` yourself; that command does not delete the branch.
The one automatic removal is a delegated child's checkout (below): it is removed
when the child ends with no changes and no new commits, and kept otherwise.

A removal also refuses a checkout another live session or subagent is working
in. `namzu worktree resume there` opens a checkout in a new terminal; that
session records the checkout it works in under the Namzu state folder, and the
child's cleanup, or any other removal, reads it before deleting anything. The
refusal names the checkout and the folder the other session works in, and
leaves its uncommitted files untouched: the checkout stays, and can be removed
once that session has ended. A path no live session holds is removed exactly
as before.

The `Agent` tool can also create one managed checkout per delegated child with
`workspace: "worktree"`. Its generated branch and path appear in the child's
result and in `namzu worktree list`. That child starts from the selected
checkout's committed HEAD and works in the corresponding subdirectory when
launched below the Git root. See
[Delegated work](delegated-work.md) for the launch and retention behavior.

## Worktrees made by a hook

A hook on `worktree_create` can make the worktree instead of Git: another
version-control tool, a prepared checkout, a plain copy. It prints the folder it
made as its last line, and Namzu uses that folder for `namzu worktree create`,
`namzu worktree fork`, `/worktree create` and a delegated child's
`workspace: "worktree"`, and creates none itself. Outside a Git checkout, these
work when such a hook exists. If the hook fails or prints no path, the creation
fails with a line naming the hook and what it printed; Namzu never falls back to
Git behind your back. A hook on `worktree_remove` does the removing.

A worktree a hook made is the hook's: `namzu worktree list` does not show it, and
Namzu runs no Git removal on it. Without a `worktree_remove` hook it is left in
place and Namzu says where. A folder nobody trusted does not run its own hooks, so
`namzu worktree create` and `fork` there refuse, creating nothing, when the
folder's config declares a `worktree_create` hook; run `namzu` in the folder once
and accept the trust prompt first. See [Worktrees](../sdk/hooks.md#worktrees) for what
the hooks receive and answer.
