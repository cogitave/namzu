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
shared state. Nothing "is registered" until a runtime component — today
`ToolRegistry`, later the `ToolManager` a separate plan describes — is
handed one. Building a toolset never runs a tool and never talks to a
server; it only describes where tools come from and what they are.

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
  plain predicate function) admits. A selector is an array of tool names,
  `{ metadata }` (a deep-match against `ToolDefinition.metadata`: every key
  in the pattern must be present and equal, or, for a nested plain object,
  recursively matched; an array matches an array of the same length whose
  elements deep-match pairwise), or `{ sourceIdGlob }`. The glob form is
  all-or-nothing per toolset: it tests the *toolset's own* `source.id`
  against the pattern (see below), not a per-tool source, so it keeps
  every tool when the toolset's source matches and none when it does not.
- `deferred(toolset)` — sets `availability` to `'deferred'` without
  touching the tools themselves.
- `requireApproval(toolset, selector?)` — sets
  `ToolDefinition.requiresApproval` on the tools `selector` admits (every
  tool, when omitted). This only declares the requirement; enforcing it —
  asking every mode, refusing when unattended, letting a `deny` rule still
  win — is a runtime concern outside this module.
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
`server` and `readOnlyHintTrusted`): the lean shape a later item stamps
onto each `ToolDefinition` as `source`, replacing today's
`ToolDefinition.provenance`. Nothing in this module writes it onto a tool
yet — there is nowhere on `ToolDefinition` for it to go until that wiring
lands — so it exists here only because source ids and their glob matching
are this module's concern.

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

## Not yet built

`ToolRegistry` (`packages/sdk/src/registry/tool/execute.ts`) does not yet
take a `Toolset`; a toolset built with this module is a value a caller
holds until a later item wires it in. `requiresApproval` and `metadata` on
`ToolDefinition` are declared for this module's wrappers to set and match
on, but nothing in `registry/tool/execute.ts` enforces or reads them yet.
