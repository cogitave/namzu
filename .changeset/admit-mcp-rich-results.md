---
'@namzu/sdk': minor
---

Preserve remote MCP rich-result provenance all the way to provider requests and
preflight image batches before model delivery. Invalid or MIME-mismatched image
containers remain exact in durable history and host data while the model sees a
diagnostic; `ModelContentOmission.reason` adds `invalid-image` for that state.
