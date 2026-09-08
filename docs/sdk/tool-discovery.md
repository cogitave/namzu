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
The query runtime registers this tool when the registered roster contains
deferred tools; the run's tool-access limits still apply.

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
