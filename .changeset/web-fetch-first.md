---
'@namzu/sdk': minor
---

`web_fetch` answers a PDF with one line saying it does not read PDFs, instead of decoded bytes, and its failure texts point to the browser tools rather than a shell fetch. A `search_tools` result is never cleared by compaction or tool-result editing, so a tool the model loaded stays loaded. The `browser` and `search_tools` descriptions say when to use `web_fetch` first and to load several tools in one call. No call needs changing.
