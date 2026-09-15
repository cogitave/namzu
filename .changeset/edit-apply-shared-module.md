---
"@namzu/sdk": patch
---

Internal only: `edit`'s apply core (normalizing a call's arguments and applying its replacements or insertion) now lives in a shared internal module instead of being private to the `edit` tool's file. No exported symbol, tool behavior, error message or file output changes — this is a pure refactor that lets a later projection reuse the exact same apply logic instead of a separate reimplementation.
