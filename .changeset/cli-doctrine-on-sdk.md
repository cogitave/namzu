---
"@namzu/cli": patch
---

The working doctrine the model reads and the interactive `ask_user_question` tool now come from `@namzu/sdk`. The prompt text is byte-for-byte what shipped; the question tool no longer has to be built through the coordinator set with a placeholder run id.
