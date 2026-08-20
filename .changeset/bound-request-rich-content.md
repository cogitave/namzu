---
'@namzu/sdk': major
---

Provider requests now limit accumulated inline user attachments and rich tool-result images/documents to 24 MiB by default. Over-budget requests replace the oldest payloads with model-visible markers without modifying `Run.messages`, durable history, checkpoints, or tool call/result identity. This changes the previous unbounded default; set `maxRequestRichContentBytes: 0` on the run or agent config to retain it. The effective value is persisted in run metadata, and `DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES` exposes the shipped default.
