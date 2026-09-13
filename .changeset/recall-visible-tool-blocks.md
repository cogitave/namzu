---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Automatic evidence recall now recognizes text already present in tool text
blocks and earlier preparation stages. Those passages receive source references
instead of occupying slots intended for missing information. Images, documents
and private reasoning are not treated as visible text, and separate blocks are
never joined to invent a matching passage. Existing scope validation, context
limits and opt-in behavior are unchanged.

CLI automatic discovery can fill a candidate page from several completely
searched runs, within the same byte, output and page limits. It no longer
spends one automatic page on every small matching run. Explicit literal
searches retain their early return; unfinished source pages still require
continuation. Serialized matches, including escaping, share the output cap.
