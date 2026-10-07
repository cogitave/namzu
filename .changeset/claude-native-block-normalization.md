---
"@namzu/cli": patch
---

Preserve observed Claude tool calls and results when the engine emits thinking, text and tool blocks under one native message ID. Complete streamed messages at the native message boundary instead of the first content block, retain authoritative inputs and interrupted partial text, and ignore duplicate or older-operation receipts. Public wire shapes and permission admission are unchanged.
