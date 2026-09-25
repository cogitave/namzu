---
type: Reference
title: Tool discovery receipts
description: Source-bound schema receipts, host readiness, and ranked deferred search.
resource: packages/sdk/src/toolsets/manager.ts
tags: [sdk, tools, discovery]
status: stable
---

# Tool discovery receipts

Availability is **derived, not stored**. A tool whose host-owned
`Toolset.isReady()` check is false is `'suspended'`: it is absent from prompts
and search, and execution refuses it. Otherwise a tool is `'deferred'` if
its owner declared `deferred(...)` and no matching receipt exists in the
post-compaction message history; the remaining tools are `'active'`.
`ToolManager` (`toolsets/manager.ts`) reads readiness and history fresh.
Use `readyWhen(toolset, check)` to attach a host-owned prerequisite such as
a live connection. A failed or throwing check suspends the toolset.

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
roster. A caller-provided `search_tools` must be active and ready when
deferred tools exist; a runtime override cannot defer or suspend it. Either
invalid setup fails before the model request, instead of leaving discovery
without an executable search tool.

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

## A successful result can load deferred schemas

`search_tools` is one way to load a deferred schema; a tool's own
successful result is another. Both use the same receipt mechanism.
`ToolResult.reveals?: readonly string[]` names deferred schemas this
successful result loads. It does not establish that a connection or other
prerequisite is ready. For a connect flow, the host owns the connection
state, wraps the dependent toolset with `readyWhen(...)`, and returns
`reveals` only after connecting. `search_tools` cannot bypass that readiness
check. A result marked failed, cancelled or overridden as an error grants
no receipt, even when it carries `reveals`.
Readiness is an admission check, not an authorization decision. The tool
execution policy still applies, and a tool should handle a connection that
fails after its readiness check.

Only a name currently `'deferred'` is revealed, and only when it is also
inside `ToolContext.allowedTools` when that turn is narrowed to an
allow-list — the same access-scoping `search_tools` applies. Every other
name is silently ignored rather than throwing or failing the call: an
unknown or misspelled name and an already-active name both pass through
unchanged. A tool result can grow what a turn may call; it can never widen a
narrowed turn's allow-list.

The executor writes the admitted set to `ToolMessage.revealedTools` as
`{ name, sourceId, sourceKind }` receipts. `ToolManager.availability`
requires a receipt for the tool's current owner; an old source's receipt
cannot load a replacement that reuses its name. Old name-only receipts no
longer load tools. The receipt is persisted with the message and follows
session history, but host readiness is checked again on every use.

## Availability across sends, resume and children

Schema receipts follow message history. Host readiness follows the host's
current state; a remembered receipt never proves an old connection is
still live.

- **Same session, later send.** A tool loaded in an earlier send stays
  loaded if the same source still serves it and the host reports ready.
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
- **Compaction resets schema receipts.** `ToolManager.availability`
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
caller passed. A toolset's own `availability` (for example, from the
`deferred(...)` wrapper) is the whole-toolset default every
tool in it starts from; there is no per-tool override on a shared object to
flip later. A caller that wants a narrower or wider roster for one turn
builds a different `toolsets` array for that turn, rather than forking a
shared one.
