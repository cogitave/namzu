---
"@namzu/sdk": patch
---

`PromptBuilder.build()` now returns the same text a request sends: the static segment, the separator and the dynamic segment, in that order. Before, it placed tool, environment and shell sections ahead of static contributions, so the whole-prompt cache hash was computed over a different order than the request used. Nothing to do on upgrade; a host that compared `build()` output against an earlier string sees the new order.
