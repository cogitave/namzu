---
"@namzu/sdk": major
---

`read_memory`'s output is no longer the memory body alone for text and Markdown records.

For a store that implements `getRecord` — `DiskMemoryStore`, `InMemoryMemoryStore` and `MarkdownMemoryStore` all do — `read_memory` now appends, after the body, a `---` line, then when the memory was last updated and how old it is, a notice to verify named files and functions when it is older than today, and each `[[name]]` link resolved. This is what lets the model see that a memory is a point-in-time claim.

What breaks: a host that displayed or parsed `read_memory`'s `output` as the stored body sees the footer after it. A record saved with `format: 'json'` is unaffected — its output is still exactly the stored text and still parses — so only prose records change.

What to do: take the body from the store (`store.get(id)`) rather than from the tool's output, or strip everything from the last `\n\n---\n`. `data` carries `updatedAt`, `name`, `type` and the resolved `links` for every format.
