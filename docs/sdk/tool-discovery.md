---
type: Reference
title: Tool discovery receipts
description: Derived availability, a reveal mechanism any tool can use, and ranked deferred search.
resource: packages/sdk/src/toolsets/manager.ts
tags: [sdk, tools, discovery]
status: stable
---

# Tool discovery receipts

Availability is **derived, not stored**. A tool is `'deferred'` if and only
if its owning `Toolset` declared `deferred(...)` AND no tool message in the
turn's post-compaction history has revealed its name; otherwise it is
`'active'`. Nothing mutates a stored map to make this true — `ToolManager`
(`toolsets/manager.ts`) recomputes it, fresh, on every `availability(name)`
call, from the toolset's own declaration plus a scan of the messages its
`messages()` accessor returns. See "A tool's own result can reveal further
tools" below for what writes to that history.

`search_tools` searches deferred tools by name, description and model-facing
argument names. It reveals the five highest-ranked permitted matches and
returns up to five further matches as explicitly unrevealed suggestions.
Generic words such as `tool`, `search` and `read` do not reveal whole
catalogues. An exact tool name still matches, including short or generic
names such as `ls` and `read`; it does not reveal tools that merely contain
that word. `query()` adds `search_tools` to the turn's own `runtime` toolset
only when something could actually be deferred — one of its own generated
tools, or a caller toolset that declared itself `deferred(...)`; the turn's
tool-access limits still apply. The discovery prompt recommends
`search_tools` only when it is active and included in the prompt's permitted
roster.

When no permitted deferred tool matches, the receipt says so — plainly, with
no active-tool echo. `ToolsView` (what a tool body reaches through
`ToolContext.toolRegistry`) has no active-tool search, only `has`,
`availability` and `searchDeferred`; a tool-body-facing search over the
active catalogue does not exist in this model, since a tool cannot mutate
anything by finding an active peer.

Results respect `ToolContext.allowedTools`: an absent list imposes no
additional narrowing, while an explicit empty list reveals nothing. A
no-match result describes the permitted roster; it does not reveal whether
another tool exists outside that scope.

## A tool's own result can reveal further tools

`search_tools` is one way a deferred tool becomes callable; a tool's own
result is another, and both go through the exact same mechanism now —
`search_tools` reveals via its result like any other tool would.
`ToolResult.reveals?: readonly string[]` names further tools this result
makes callable for the rest of the turn — for a "connect to project X" call
whose dozen further tools should appear only once the connection is made,
not be found by lexical search or exposed eagerly from the start. Any tool
built with `defineTool` sets it as an ordinary field on the object its
`execute()` resolves to, exactly as it already sets `data` or
`workingState`.

Only a name currently `'deferred'` is revealed, and only when it is also
inside `ToolContext.allowedTools` when that turn is narrowed to an
allow-list — the same access-scoping `search_tools` applies. Every other
name is silently ignored rather than throwing or failing the call: an
unknown or misspelled name and an already-active name both pass through
unchanged. A tool result can grow what a turn may call; it can never widen a
narrowed turn's allow-list.

The executor writes the filtered, admitted set onto the tool message it
builds from the call's result, as `ToolMessage.revealedTools` — a plain,
persisted field, written and read like any other message field, with no
separate store to keep in sync, restore on resume, or lose across a fork of
the message history. This is what `ToolManager.availability` scans for: a
name is revealed once some tool message in the post-compaction window
carries it in `revealedTools`.

## Availability across sends, resume and children

Because revelation lives in the message history rather than in a mutable
map on a shared object, it follows the history: a session that shares
history up to some point shares the same derived availability up to that
point, automatically, with nothing to fork, restore or remember to carry
forward.

- **Same session, later send.** A tool revealed in an earlier send is still
  revealed in a later one, because the earlier send's tool message — and
  its `revealedTools` — is still in the history a later send's `ToolManager`
  reads.
- **Resume**, including a checkpoint/HITL pause. The resumed turn's
  `ToolManager` is built fresh from `query()`'s own `messages()` accessor
  over the recorder's history, which already includes every prior
  revelation — there is no separate activation snapshot to restore, because
  there never was a separate mutable state to lose.
- **A delegated child.** A child that receives a different message history
  (the ordinary case: a fresh sub-task) starts with nothing revealed, since
  its own history has no tool message carrying a reveal yet. A child that is
  handed the parent's history inherits the parent's revealed set, for the
  same reason a resumed turn does.
- **Compaction is the one deliberate reset.** `ToolManager.availability`
  scans only the window after the turn's last compaction summary
  (`compaction/summary.ts`'s `isCompactionMessage` marker); a name revealed
  before that point is forgotten, the same way namzu's own summarisation
  treats everything before it as folded away.

## Toolsets, not a shared mutable registry

There is no `ToolRegistry` to fork, register into or mutate live. A turn's
tools come from `toolsets: readonly Toolset[]` (`toolsets/types.ts`), and
`query()` builds one `ToolManager` per turn from that fixed list plus its
own generated `runtime` toolset (task tools, `search_tools`, the
structured-output tool, advisory tools) — it never writes into what the
caller passed. A toolset's own `availability` (`toolset()`'s third
argument, or the `deferred(...)` wrapper) is the whole-toolset default every
tool in it starts from; there is no per-tool override on a shared object to
flip later. A caller that wants a narrower or wider roster for one turn
builds a different `toolsets` array for that turn, rather than forking a
shared one.
