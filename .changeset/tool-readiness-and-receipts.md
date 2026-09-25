---
'@namzu/sdk': major
---

`ToolMessage.revealedTools` now stores `{ name, sourceId, sourceKind }` receipts instead of name strings. Code that constructs these messages directly must include the source of each revealed tool; old name-only receipts in stored sessions no longer load deferred tools and must be rediscovered. A failed tool call no longer reveals tools. Hosts whose tools need a live connection should wrap their toolset with `readyWhen(toolset, () => connectionIsReady)`; `deferred(...)` only delays schema loading and `search_tools` can load it whenever the host reports ready. A caller-provided `search_tools` must be active and ready when deferred tools are present, and a runtime override cannot defer or suspend it.
