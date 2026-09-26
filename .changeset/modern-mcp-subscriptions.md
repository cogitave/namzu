---
'@namzu/sdk': minor
---

Modern MCP connections now follow advertised tool, prompt, and resource catalogue changes through `subscriptions/listen`. `mcpToolset` refreshes its live definitions after an acknowledged change, and Streamable HTTP reads the subscription incrementally instead of waiting for the long-lived response to end. Hosts using `StreamableHttpTransport` directly can use `sendSubscription` for a bounded SSE stream; existing legacy notification behavior is unchanged.
