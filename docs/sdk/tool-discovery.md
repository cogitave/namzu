---
type: Reference
title: Tool discovery receipts
description: Source-bound schema receipts, host readiness, the select, keyword and required-word search forms, and loaded tools that survive compaction.
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

`search_tools` takes three query forms. `select:a,b` (comma-separated, trimmed,
up to 64 names) loads exactly those tools: an exact name, or, for an MCP tool
(`mcp__<server>__<tool>`), its short name, which loads that tool from every
server that has one. A name that is already loaded is answered
`Already loaded, call directly`, one nothing matched is listed as not found,
and a tool's companions (below) are named but not loaded. A query that is
exactly one tool's name loads that tool alone (with its companions). Anything
else is keywords: each word scores by where it sits, a whole word of the name
(10; 12 for an MCP tool) far above a piece of a name word (5; 6), a word of the
description on a word boundary (2) or an argument name (2); a word written
`+term` is required, a result must carry it in its name, description or
argument names. `max_results` (new, an integer 1 to 64, default 5) is how many
a keyword search loads; up to five further matches are returned as explicitly
unrevealed suggestions. The generic words `tool`, `list`, `read`, `get` and the
like are ignored; `search` is ignored too unless a deferred tool's name has it
(`web_search`, `search_memory`), so `web search` ranks `web_search` first.
The system prompt lists the names of deferred MCP tools without repeating
their server-authored descriptions. Those short descriptions reach the model
as a labelled, untrusted `step-context` message after conversation history,
only for tools permitted in that request. `search_tools` still searches their
full descriptions and can load their schemas; moving the hint does not remove
the tool from discovery. A host that renders `ToolManager.toPromptSection()`
itself can use `toUntrustedDeferredContext()` in a request-only context
channel to provide the same hints without treating server text as a system
instruction. The list of hints is capped at 4,000 characters per request;
its untrusted provenance frame adds a small amount of text. The runtime
captures them before step preparation, prices the broad snapshot against
context room, and filters that snapshot to the step's permitted tools. Hosts
that prepare their own steps can use `snapshotUntrustedDeferredContext()` for
the same bounded snapshot. The minimal context level omits both listings.
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

A tool can declare `loadsWith: readonly string[]` (on `ToolDefinition` and
`defineTool`), the names of tools that are needed right after it. When
`search_tools` loads such a tool it loads those companions in the same call,
marks each `(loaded with <tool>)` in its result, lists them as
`data.companions` and reveals them like any other match. A companion is
loaded only if it is deferred and inside `ToolContext.allowedTools`; one that
is already loaded is simply left out, and a companion's own `loadsWith` is not
followed. Companions do not count against `max_results`. The shipped
pairs are `browser` with `browser_act` (looking at a page and acting on it,
both ways) and `task_create` with `task_update` (a task is made to be moved
through its statuses). The deferred catalogue line of a tool with companions
ends `(loads with <names>)`. Memory tools, `task_list` and `computer_use` are
not grouped: each is used alone as often as with another.

When no permitted deferred tool matches, the receipt says so — plainly, with
no active-tool echo. `ToolsView` (what a tool body reaches through
`ToolContext.toolRegistry`) has no active-tool search, only `has`,
`availability`, `searchDeferred` and `select` (the exact-name lookup behind
`select:`); a tool-body-facing search over the
active catalogue does not exist in this model, since a tool cannot mutate
anything by finding an active peer.

Results respect `ToolContext.allowedTools`: an absent list imposes no
additional narrowing, while an explicit empty list reveals nothing. A
no-match result describes the permitted roster; it does not reveal whether
another tool exists outside that scope.

## The catalogue is not live availability status

The prompt's `available_tools` and `deferred_tools` catalogue is a discovery
snapshot, not live status. The **current runtime tools parameter** is
authoritative: when a tool's schema is visible there, call it directly, even
if the boot-time catalogue lists it under `deferred_tools`. Do not search
again merely because that older listing remains in the prompt. Only when a
needed deferred schema is absent should the model call `search_tools` with
its exact name (or `select:<name>`). A successful reveal makes the schema available on the next
model request in the same turn and, with retained source-bound receipts,
on later sends. A compaction summary carries the loaded tools forward, as described below; readiness,
step allow-lists and authorization still apply independently of discovery.

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
- **Compaction keeps loaded tools.** When a pass writes its summary it
  records the receipts of every tool the cut messages had loaded, plus those
  the earlier summaries carried, on the summary itself
  (`SystemMessage.revealedTools`, `collectRevealedTools()` in
  `compaction/summary.ts`). `ToolManager.availability` counts the last
  summary's receipts and the receipts after it, so a tool loaded before a
  compaction is still callable after it, and resume and fork keep it because
  it lives in the history. The summary ends with
  `Tools you loaded earlier with search_tools are still loaded: <names>`, so
  the model knows without searching. A summary written without receipts (an
  older session, or `buildCompactionMessage(body)` called with no third
  argument) forgets them as before: only the window after it counts.
- **A toolset that gains tools mid-turn is announced.** Each iteration calls
  `ToolManager.refresh()`; when a live toolset (an MCP server that connected
  after the turn began) added or removed tools, one recorded context entry
  under the key `tools-changed` names them (`describeChange()`): deferred
  names with the way to load them, tools that are now loaded, and tools no
  longer available. An MCP tool's description is not repeated there.
  `query()` also mounts `search_tools` for a deferred toolset that has no tools
  yet but reports changes.

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

Generated planning tools require `query()`'s `taskStore`; caller toolsets alone
do not enable `task_create`, `task_update` and `task_list`. See
[task tracking](task-tracking.md) for planning state, delegated invocation
handles and host composition.

## The CLI defers by default

`@namzu/cli` builds every agent session (terminal, `exec`, ACP and the
Desktop host, Pal sessions) with `toolLoading: 'deferred'` unless the caller
passes `'eager'`. Only a resident set sends its schema on every request:
`read`, `glob`, `grep`, `write`, `edit`, `bash`, `job` and `wait_for_job` (the
bash description sends the model to both), `skill`, `search_tools`, the
delegation tool `Agent`, `ask_user_question` and `session_cost` (a cost
question is short, and a search first would double it). Everything else,
including web search and fetch, conversation search and read, the memory and
task tools, the workflow and coordinator tools, `browser`,
`browser_act`, `computer_use`, `code_analysis`, `monitor` and every MCP tool
(unless its server sets `alwaysLoad: true`, see [tool servers](../cli/mcp-servers.md#tool-search)),
is listed in the system prompt under `<deferred_tools>` with its name and a
one-line purpose, and its schema arrives through `search_tools`.

A call to a deferred tool before it is loaded is refused with one short
result, `Tool "<name>" is not loaded yet. Call search_tools with its exact
name, then call it again.`; the turn goes on. The memory, conversation-evidence
and web-task sections of the prompt say the same where they name a tool that
may be deferred. `toolLoading: 'eager'` brings back the old roster, every
schema on every request.
