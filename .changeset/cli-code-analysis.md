---
"@namzu/cli": minor
---

The interactive terminal now offers a `code_analysis` tool: cited, paged lookups over an index of the project's JavaScript and TypeScript (find a string literal and the function around it, read that function whole, list its callers or a file's imports), each result saying what was observed, what was inferred and whether coverage is complete. It is on by default, adds about 1,000 tokens of tool description to each request, and builds its index only when the model first calls it, under `~/.namzu/cache/analysis`. To turn it off, set `codeAnalysis` to `{ "enabled": false }` in your user, project or managed config; `enabled: false` in any file holds. `exec`, `drain` and `acp` do not offer it. The CLI now installs `oxc-parser`, a native dependency, for the index.
