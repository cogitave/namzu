---
'@namzu/sdk': minor
---

`search_tools` has an exact form and a better ranking, and tools it loaded stay loaded across a compaction. Nothing you call changes, so there is nothing to do; read the list for behaviour you may notice.

- `select:a,b` loads exactly the named deferred tools (up to 64, an MCP tool by full or short name). A query that is exactly one tool's name loads that tool and no other match, plus any companions it declares. `+term` requires a word in the result. The new optional `max_results` input (1 to 64, default 5) bounds a keyword search.
- Keyword ranking now weighs a word of a tool's name far above a word of its description (name word 10, name piece 5, description word 2, required `+term`), and `search` counts when a tool's name has it, so `web search` finds `web_search`. If you relied on the old weights (name 12 / contains 8 / description 5 / argument 3), results may order differently.
- A compaction summary now carries the tools loaded before it (`SystemMessage.revealedTools`, `collectRevealedTools`, an optional third argument of `buildCompactionMessage`), `ToolManager.availability` counts them, and the summary ends with a line naming them. Before, every loaded tool went back to deferred after a compaction and the model had to search again. A summary written without receipts behaves as before.
- The turn loop now calls `ToolManager.refresh()` each iteration and records one `tools-changed` context entry when a live toolset gained or lost tools (`ToolManager.describeChange`). `query()` mounts `search_tools` for a deferred live toolset that has no tools yet. `ToolsView` gained an optional `select`.

The tools-changed announcement and the loaded-tools line in a compaction summary are bounded and end in a count. A `select:` list past 64 names says which names were not loaded, and a short MCP name that matches several tools says it loaded all of them. `DATA_EPOCH` is deliberately unchanged: an older engine that resumes a session written by this one ignores the new `revealedTools` field, so loaded tools go back to deferred after the resume and nothing else is lost.
