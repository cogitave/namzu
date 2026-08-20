---
'@namzu/cli': patch
---

Preserve complete SDK messages supplied to stateless `run-stream` on stdin, including opaque reasoning, attachments, citations, and tool exchanges. Malformed or provider-incomplete history now refuses before a run instead of silently continuing with dropped context.
