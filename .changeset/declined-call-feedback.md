---
'@namzu/sdk': minor
'@namzu/cli': patch
---

A tool call a person declines without giving a reason now tells the model not to get the same content or result another way — another tool, another site or address, or a web search — unless it asks first and the person agrees. The text was "User declined to run the proposed tool(s)." (and "The user rejected this tool call." on a resumed decision); in a live session a model whose browser navigation was declined fetched the same page through web search instead.

New export: `DECLINED_TOOL_CALL_FEEDBACK`, the text. A host that passes its own `feedback` with a refusal is unchanged. A test or host that matched the old default text must match the new one.
