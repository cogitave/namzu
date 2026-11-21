---
'@namzu/openrouter': patch
---

A long conversation through OpenRouter reads far more of its input from the prompt cache. Each assistant message now goes back with the reasoning it was sent with before, on every request; earlier turns used to be re-sent without it, which changed the cached prefix at each new user message and billed the whole history again (one run read 67% of its input from the cache instead of about 90%). Reasoning still leaves the history only when a compaction rewrites it. The model list now reads a negative rate (`-1`, OpenRouter's mark for a router such as `openrouter/auto`) as unknown instead of as a price.
