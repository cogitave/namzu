---
"@namzu/sdk": patch
---

Keep an assistant message's runtime stream ID when recording its durable history and final settlement, including forced closing summaries. ACP clients can now reconcile the settled answer with its streamed message instead of displaying it twice. Distinct messages with identical text retain separate identities; caller-authored message IDs are not trusted as stream identities.
