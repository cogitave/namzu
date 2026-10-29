---
"@namzu/openai": patch
---

Skip assistant history entries with neither content nor tool calls after Chat Completions wire conversion. Interrupted replies and reasoning-only turns from another provider no longer cause OpenAI-compatible endpoints to reject a request as an empty assistant message. Stored history and reasoning are unchanged; tool-only assistant turns and their results remain in the request. Applies to streaming and non-streaming API-key calls, not the separate ChatGPT subscription Responses wire.
