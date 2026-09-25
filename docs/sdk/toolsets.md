---
type: Reference
title: Toolsets
description: The unit every tool comes from, its composable wrappers, and combineToolsets's atomic conflict detection.
resource: packages/sdk/src/toolsets/
tags: [sdk, tools, toolsets]
status: stable
---

# Toolsets

A `Toolset` is a value, not a registration: `toolset()`, every wrapper in
this module, and `combineToolsets` each build one without touching any
shared state. Nothing "is registered" until a runtime component — a
`ToolManager` (below) — is handed one. Building
a toolset never runs a tool and never talks to a server; it only describes
where tools come from and what they are.

## The shape

`Toolset.source` is a `ToolSource` (`id`, `kind`, `name`, and kind-specific
fields such as `mcpServer`) — ownership and trust for every tool the
toolset contributes stay with this value, and a wrapper never changes it.
`Toolset.tools()` returns the current snapshot in a deterministic order,
called fresh whenever a caller wants it: a wrapper re-derives its mapping
or filtering on every call instead of caching, so a live inner toolset's
change is visible the moment `tools()` is called again, with no separate
invalidation step. `Toolset.availability` (`'active'` or `'deferred'`,
default `'active'`) is the toolset's own default for the tools it
contributes. `Toolset.onChange(listener)` subscribes to "the next `tools()`
call may return something different" — an MCP server's `list_changed`, for
instance — and returns the unsubscribe function; it is absent when a
toolset never changes on its own, which is true of every plain `toolset()`.
`Toolset.close()` releases whatever the toolset holds open.

`toolset(source, tools)` builds the plain, static case: a fixed list of
tools from one source, snapshotted once at construction so a caller
mutating the array it passed in afterward cannot change what the toolset
reports. A bare string in place of a full `ToolSource` is shorthand for a
`host_tool` source with that string as both `id` and `name` — the common
case for a small, in-process bundle ("builtin", "memory") with no separate
discovery metadata worth writing out. The shorthand never guesses a richer
`kind` from the text of the id; anything that needs `mcp_server` or another
kind passes a full `ToolSource`.

## Wrappers

Every wrapper takes a `Toolset` and returns a new one that keeps the
*inner* toolset's `source` — ownership and trust stay with the real
source — and forwards its `onChange`/`close` unchanged. A wrapper never
re-dispatches a call by name: renaming changes a tool's `name` field only,
and `execute` stays the exact same closure, along with every other field
the tool carried.

- `prefixed(toolset, prefix)` — prepends `prefix` to every tool's name.
- `renamed(toolset, names)` — renames the tools named as keys in `names` to
  their mapped value; a tool whose name is not a key keeps its name.
- `filtered(toolset, selector)` — keeps only the tools a selector (or a
  predicate function) admits. A selector is an array of tool names,
  `{ metadata }` (matched with `matchesToolSelector`, `tools/roster.ts`: a
  deep-match against `ToolDefinition.metadata` — every key in the pattern
  must be present and equal, or, for a nested plain object, recursively
  matched; an array matches an array of the same length whose elements
  deep-equal pairwise), or `{ sourceIdGlob }`. The glob form is
  all-or-nothing per toolset: it tests the *toolset's own* `source.id`
  against the pattern (see below), not a per-tool source, so it keeps
  every tool when the toolset's source matches and none when it does not.
  A predicate function is `(tool, source) => boolean`: `source` is the ONE
  toolset `filtered` runs on (`ts.source`, projected through
  `toToolSourceRef`), the same reason the glob form is all-or-nothing — no
  per-tool source exists yet. This is what a read-only-only roster reads
  (`filtered(ts, (tool, source) => isTrustedReadOnly(tool, undefined,
  source))`, `tools/roster.ts`), and why building one means filtering each
  of a wider roster's contributing toolsets this way and THEN combining
  them: call it on a toolset `combineToolsets` already merged from several
  sources and `source` is the merge's own umbrella source, not any
  contributor's, so an untrusted MCP server's tool would pass a check meant
  to keep it out.
- `deferred(toolset)` — sets `availability` to `'deferred'` without
  touching the tools themselves.
- `requireApproval(toolset, selector?)` — sets
  `ToolDefinition.requiresApproval` to an always-`true` predicate on the
  tools `selector` admits (every tool, when omitted). This only declares
  the requirement; asking every mode, refusing when unattended and letting
  a `deny` rule still win is `runtime/query/review-policy.ts`'s job.
- `withMetadata(toolset, metadata)` — merges `metadata` onto every tool,
  keeping whatever metadata a tool already carries (a key in the argument
  overwrites the same key already there).
- `mapTools(toolset, fn)` — the primitive the wrappers above are built
  from: applies `fn` to every tool, recomputed on every `tools()` call.

Wrappers compose in the order they are written: `prefixed(renamed(ts, {
read: 'get_file' }), 'demo__')` renames first and then prefixes the
result, so `read` becomes `demo__get_file`; written the other way around,
`renamed` looks for a tool literally named `read` in a toolset that
`prefixed` has already renamed to `demo__read`, and misses.

## Source ids and globs

A source id is a hierarchical string with a kind implied by convention —
`builtin`, `mcp:github`, `plugin:acme`, `plugin:acme/mcp:db` — though the
authoritative kind is always `ToolSource.kind`, never parsed from the id.
`matchesSourceIdGlob(id, pattern)` matches an id against a glob pattern
where `*` matches any run of characters, including `/` and `:` — so
`plugin:acme/*` matches `plugin:acme/mcp:db` in one step. There is no
`**`, `?` or character class; the id space does not need them. A pattern
with no `*` is an exact match.

`toToolSourceRef(source, mcp?)` projects a `ToolSource` down to
`ToolSourceRef` (`id`, `kind`, and — only for `kind: 'mcp_server'` —
`server` and `readOnlyHintTrusted`). `ToolManager.sourceOf(name)` returns
this reference for the tool's owning toolset; the reference is not stored
on `ToolDefinition`.

For an `mcp_server` source, `readOnlyHintTrusted` defaults to
`source.mcpServer?.readOnlyHintTrusted` — the operator's per-server trust
decision (one value per connected server, not per tool), which `mcpToolset`
sets on its source. The optional `mcp` argument
overrides that default rather than being the only way to supply it, for a
caller that already has the decision in hand some other way.

## Combining toolsets

`combineToolsets(source, toolsets)` merges several toolsets into one,
under a new umbrella `source`. It is atomic: `tools()` either returns the
full merged list or throws `ToolsetConflictError` — never a partial list.
Every call recomputes from the inner toolsets' current `tools()`, so a name
that only collides after a live inner toolset changes is caught the next
time `tools()` is called, exactly like any other change. Order is
deterministic: toolset order (as given), then each toolset's own tool
order.

A collision — two different toolsets contributing the same tool name, or
one toolset contributing it twice — throws `ToolsetConflictError`, naming
both contributing sources (or the one source, twice) and suggesting
`prefixed(toolset, prefix)` or `renamed` to resolve it before combining
again. There is no automatic winner: `combineToolsets` never silently
drops a tool to resolve a name clash.

`onChange` and `close` on the combined toolset are defined only when at
least one inner toolset defines them — combining never fabricates a live
capability none of its inputs have. Subscribing forwards the same listener
to every inner toolset that has one; unsubscribing tears down every one of
those subscriptions, so a change three layers down still reaches a
listener on the outermost combined toolset, and cleanup at that outer
layer reaches all the way in.

A combined toolset has exactly one `availability` to report, so its inputs
must agree: combining an `active` toolset with one wrapped in
`deferred(...)` throws, naming both sources, instead of silently reporting
the deferred side's tools as `active` (there being nowhere on the returned
`Toolset` to say otherwise). Inputs that all agree — every one active, or
every one `deferred` — combine as before, and the combined toolset carries
`availability: 'deferred'` when every input does. A caller with a genuine
eager/deferred split keeps the two halves as separate entries in its own
`toolsets` array instead of combining them — see the two bug fixes
`query()` and `SupervisorAgent` needed for exactly this, below.

## `ToolManager`: the runtime-owned resolver of toolsets

`ToolManager` (`packages/sdk/src/toolsets/manager.ts`) is built once from a
fixed list of toolsets — `new ToolManager({ toolsets, resultGuardrails?,
tierConfig?, messages })`, where `messages` is an accessor for the turn's
own message history — and resolves them in toolset order, then tool order,
the same rule `combineToolsets` follows. A name two toolsets both contribute
throws `ToolsetConflictError` at construction, naming both sources.

A `ToolManager` never mutates its own membership on its own: a live toolset's `onChange` only marks the manager dirty, and a
caller adopts the change by calling `refresh()` — at an iteration boundary
it chooses, never mid-call. `refresh()` returns `undefined` when nothing
was signalled (the common case, so refreshing every iteration boundary
costs nothing when idle), or a `ToolsetChangeReport`:

- `added` — a name only one currently-offered toolset contributes, that
  nobody served before.
- `removed` — a name whose owning toolset stopped contributing it, with no
  other toolset picking it up.
- `drifted` — a name its ORIGINAL owning toolset still contributes, but as
  a different `ToolDefinition` object than the one that toolset returned
  the last time it was observed (construction, or the previous
  `refresh()`). The manager holds the previously admitted object rather
  than adopting the new one, so a live toolset's own internal change never
  busts the `toolWireSchema` cache (keyed by `inputSchema` object identity)
  or invalidates a preparation already in flight for that name. Because
  drift is judged against the last observation and not the served object,
  a name that drifted once and has been stable since is reported only on
  the `refresh()` where it actually changed — not again on every later
  `refresh()` that some unrelated toolset's own change happens to trigger.
- `refused` — a newcomer that collides with a name its incumbent still
  serves. The incumbent wins regardless of toolset order; the newcomer
  never reaches the manager.

### Availability is derived, not stored

`ToolManager.availability(name)` returns `'active'` or `'deferred'` —
there is no `'suspended'` state and no mutable map. A tool is `'deferred'`
iff its owning toolset declared `'deferred'` (`deferred(toolset)`, above)
AND no tool message in the turn's history, after the last compaction
summary, has revealed it. "After the last compaction summary" is namzu's
`post_compaction_window`: `compaction/summary.ts`'s `isCompactionMessage`
marks the one message a compacted history carries (a system message whose
content starts with `COMPACTION_HEADER`); everything after it — or the
whole history, if compaction never ran — is the window `availability`
scans.

A tool message reveals a name through `ToolMessage.revealedTools` — the
persisted form of `ToolResult.reveals` (see [Tool result reveals a
capability](tool-discovery.md)), written by the executor onto the tool
message it builds from that result, exactly like `isError` or any other
message field. Nothing is stored separately: resuming a session, forking
it, or replaying it for an eval reproduces the same reveal set for free as
long as the history up to the last compaction is intact, because the set is
a pure read of that history rather than a registry instance's private
state.

`toLLMTools`, `toPromptSection`, `toTierGuidance` and `searchDeferred(query,
limit?)` render from the derivation above. `sourceOf(name)` returns the
owning toolset's `ToolSourceRef` — what `ToolDefinition.provenance` used to
carry on the tool itself, before it was retired in favour of this. `view()`
returns the narrow, read-only `{ has, availability, searchDeferred }` slice
a running tool's own `ToolContext` is given, as a `ToolsView`.
The authorization gate reads that same source for `by_source` rules; see
[Rules that ask](review-policy.md#rules-that-ask).

### The execution pipeline

`prepareExecution` / `executePrepared` / `execute` are the decode-once
preparation pipeline: a frozen review projection and a retained execution
value in a `WeakMap`, ordered checks (availability → `allowedTools` →
plan-mode read-only gate → execute + guardrail screening, with the
halt/fail distinction and the explicit parent span for async-generator
tracing). Availability comes from the derivation above; the source comes
from `sourceOf(name)` for the plan-mode read-only gate and the result
screen's `provenance` context.

`ToolManager` is exported as an advanced API; `query()` builds one per turn
from the `toolsets` it is given, combined with its own generated `runtime`
toolset (task tools, `search_tools`, the structured-output tool, advisory
tools) — see [Tool discovery](tool-discovery.md) for how availability
behaves across sends, resume and children under this model.

## MCP

`mcpToolset(client, options)` (`packages/sdk/src/connector/mcp/mcp-toolset.ts`) returns two live toolsets to mount together: tools and prompts under the configured availability, and resources always deferred. Names use `mcp__<server>__<rest>`; both entries react to `list_changed` and reconnection. See [The MCP toolset](mcp-toolset.md).

## Approvals and metadata

`requiresApproval` (a predicate of the tool's input, set by
`requireApproval` as always-`true`) and `metadata` on `ToolDefinition` are
enforced and matched outside this module — see [The review
policy](review-policy.md#a-call-the-tool-itself-declares-always-needs-approval)
and `matchesToolSelector` (`packages/sdk/src/tools/roster.ts`), which
`filtered`'s `{ metadata }` selector defers to.

## Migrating from `ToolRegistry`

Pass `toolsets: [toolset('host', definitions)]` to `query()` or an agent
instead of passing a `ToolRegistry` as `tools`. Use `deferred(toolset(...))`
for tools the model should discover later. For a different roster on one
turn, pass a different toolsets array; do not fork or mutate a shared
registry. A tool that previously called `activate(names)` returns
`ToolResult.reveals: names` instead. The runtime records admitted names in
tool messages, so they remain available on later sends and resume until
compaction. `ToolContext.toolRegistry` now exposes only `has`,
`availability` and `searchDeferred`; a host needing the full roster can
construct `ToolManager` directly. See [Tool discovery](tool-discovery.md)
for reveal and allow-list behaviour.

## The CLI's own composition

`@namzu/cli`'s session (`packages/cli/src/tui/agent.ts`) builds its roster
as a list of named toolsets rather than a registry: `builtin` (wrapped with
`mapTools` for the checkpointed file tools), `memory`, one per connected MCP
server (kind `mcp_server`, id `mcp:<server>` — `McpConnection.toolsets`,
`integrations/mcp/servers.ts`), one `plugin:<name>` file-tool source and one
`plugin:<name>/mcp:<server>` source per plugin server (all live entries from
`PluginLifecycleManager.toolsets`), `computer-use`,
`browser`, `web-search`/`web-fetch`, `session-goals`, `resident-history`,
`resident-tool-evidence`, `conversation-sessions`, `ask-user-question`,
`extra` (host `extraTools`), a dynamic `skills` toolset (its `tools()`
closure reads live plugin-skill counts, so an enable/disable is picked up
the next time `ToolManager.refresh()` is asked, with nothing to register or
unregister), and `agents`/`agents:*` (the coordinator tools — parent-only: a
sub-agent's own roster reuses the SAME `builtin`/`memory` `Toolset` objects
directly, never these). A withheld-tools denylist and
`toolLoading: 'deferred'` are both `filtered`/`deferred` wrappers applied
per named toolset — never to one toolset collapsed from the others first,
since `ToolManager` reads a derived tool's default availability off
whichever ARRAY ENTRY served its name, and a toolset combined from an
active half and a deferred half has no one availability of its own to
report (see the two bug fixes below). Its `ToolManager`, built once at
session boot over this list, is re-`refresh()`ed before every host-facing
read (`/tools`, `/permissions`, a review decision, the tool presenter) so a
plugin enabled or disabled after boot is reflected live. The ACP bridge
(`commands/acp.ts`) now delegates its presenter to whichever session's own
event is being presented (`AgentSession.presenter`) instead of a
permanently empty registry, which used to fall every tool-call/result view
back to the generic label for every session the server ever handled. That
delegation is scoped to the synchronous span of one event, not a whole
turn: two ACP sessions can have prompts in flight at once, and reading
"whichever session is currently streaming" as one connection-global slot
for the turn's whole duration let a later session's own event, presented
while an earlier one was still mid-turn, misattribute to the wrong
session's presenter.

Two bugs in how `query()` and `SupervisorAgent` used `combineToolsets` were
found and fixed while wiring the CLI onto this: both merged an eager and a
deferred half into ONE outer toolset before handing it to `ToolManager`,
which reads a tool's default availability off `toolset.availability` on
whichever array entry served it — a merged toolset carries no single
`availability` of its own, so `defaultAvailabilityByName` fell back to
`'active'` for every tool inside it, both halves, silently dropping every
`runtimeToolOverrides: { name: 'deferred' }` override the caller asked for
(task tools, the coordinator tools). Fixed by passing the two halves as
separate array entries instead. Separately, `query()` always added its own
`search_tools` once anything was deferred, even when the caller's own
`toolsets` already contributed a tool under that name (a connector
literally named `search_tools`) — the pre-toolsets registry checked
`!registry.has('search_tools')` first; the toolsets rewrite had dropped
that check, so such a caller hit `ToolsetConflictError` at construction.
Both are `packages/sdk/src/runtime/query/index.ts` and
`packages/sdk/src/agents/SupervisorAgent.ts`, `.changeset/toolsets-cli.md`,
**patch** for `@namzu/sdk`.
