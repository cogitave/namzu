---
type: Reference
title: Tool discovery receipts
description: Ranked deferred activation, verified active matches and access-scoped search results.
resource: packages/sdk/src/tools/builtins/search-tools.ts
tags: [sdk, tools, discovery]
status: stable
---

# Tool discovery receipts

`search_tools` searches deferred tools by name, description and model-facing
argument names. It activates the five highest-ranked permitted matches and
returns up to five further matches as explicitly unloaded suggestions. Generic
words such as `tool`, `search` and `read` do not activate whole catalogues.
An exact tool name still matches, including short or generic names such as
`ls` and `read`; it does not activate tools that merely contain that word.
The query runtime registers this tool when the registered roster contains
deferred tools; the turn's tool-access limits still apply.
The discovery prompt recommends `search_tools` only when it is active and
included in the prompt's permitted roster.

When no permitted deferred tool matches, the receipt checks active tools. It
lists up to five verified active matches, or reports that none were found.
An unknown name is not evidence that a tool is already active. Active search
uses the same lexical ranking and also recognizes exact short or generic tool
names, such as `ls` and `read`.

Both result sets respect `ToolContext.allowedTools`: an absent list imposes no
additional narrowing, while an explicit empty list exposes and activates
nothing. Suspended tools are excluded. A no-match result describes the permitted
roster; it does not reveal whether another tool exists outside that scope.

`ToolRegistry.searchActive(query)` returns ranked active definitions without
changing availability. `ToolRegistryRef.searchActive` and the corresponding
method on `ToolRegistryContract` are optional so existing custom registries remain
compatible. When a custom registry omits the method, `search_tools` says it cannot
search active tools rather than asserting that matching tools are active or absent.

## A tool's own result can reveal further tools

`search_tools` is one way a deferred tool becomes callable; a tool's own
result is another. `ToolResult.reveals?: readonly string[]` names further
tools this result makes callable for the rest of the turn — for a "connect to
project X" call whose dozen further tools should appear only once the
connection is made, not be found by lexical search or exposed eagerly from
the start. Any tool built with `defineTool` sets it as an ordinary field on
the object its `execute()` resolves to, exactly as it already sets `data` or
`workingState`.

Only a name currently `deferred` in the registry is activated, and only when
it is also inside `ToolContext.allowedTools` when that turn is narrowed to an
allow-list — the same access-scoping `search_tools` applies. Every other
name is silently ignored rather than throwing or failing the call: an
unknown or misspelled name, an already-active name, and a name a host has
suspended (`suspendAll`) all pass through unchanged. A tool result can grow
what a turn may call; it can never resurrect a tool a host deliberately
pulled out of reach, and it can never widen a narrowed turn's allow-list.

Activation happens when the executor finalizes the revealing tool's result,
before the model's next turn — so a tool named in `reveals` is already in the
very next request's `tools` list, with no extra round trip.

## Independent availability for a turn

`ToolRegistry.fork(options?: ToolRegistryForkOptions)` snapshots the registry's
membership and availability into a new `ToolRegistry`. A discovery activation,
registration, removal or suspension in either registry does not change the other.
Separate forks likewise keep their own availability.

By default the fork preserves each tool's current availability.
`fork({ deferExcept: ['read', 'search_tools'] })` instead defers currently active
tools outside that exact list. An empty list defers every active tool. Listing
a tool that is already deferred or suspended preserves that state; it does not
activate the tool. Every listed name must be a valid, unique registered name;
invalid, duplicate and unknown names throw before creating the fork. A host with
an optional fixed roster should intersect it with the registered names first.

The fork shares tool definitions and handlers, provenance, model and output
schemas, tier configuration and result guardrails. It is an availability snapshot,
not a deep clone or an authorization boundary: direct changes to shared definitions
or configuration remain shared, including tier changes through `assignTiers`.
Prepared executions remain bound to the registry that prepared them and cannot
be transferred to a fork. Existing execution permissions and result screening
still apply.

Use a fresh fork when each turn needs a small initial schema set without retaining
another turn's discovery activations. Deferral only changes discovery and schema
availability; it does not narrow `allowedTools`, alter standing instructions,
or configure provider-hosted tools. The query runtime can register its ordinary
runtime tools into the fork without adding them to the source registry.
