---
'@namzu/cli': patch
---

Show the complete prepared tool input in interactive permission prompts instead
of approving from a shortened summary. The terminal review is paged by physical
rows and refuses an oversized or non-JSON-compatible batch rather than
truncating it; ACP permission requests now carry the exact prepared input.
