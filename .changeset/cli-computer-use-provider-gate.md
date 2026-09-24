---
"@namzu/cli": patch
---

Computer use no longer runs blind on a provider that cannot show the model an image in a tool result (OpenAI via API key, Bedrock, OpenRouter, LM Studio, Ollama, the generic HTTP driver). The `computer_use` tool is still listed, says why it cannot be used, and refuses every call; the desktop is never touched, and the session notices say `Computer use is unavailable in this session: …`. Use Anthropic, Codex or Google for computer use.

Approving a `computer_use` call now shows each desktop action on its own line, in the order it will run, with any text to be typed shown in full.
