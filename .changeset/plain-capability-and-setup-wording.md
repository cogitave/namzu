---
"@namzu/cli": patch
---

The terminal app's notices for a provider that cannot use tools, images or documents, and for a repaired conversation history, are now plain sentences that name the provider by product name ("Ollama can’t use tools, so Namzu will only chat in this conversation. Pick another model to let it work with files and commands.") instead of "Capability warning (tools): Provider 'ollama' does not support tools — 42 registered tool(s) were stripped…". The setup screen and the provider list are reworded the same way. The previous wording still appears under `--debug`. Exported transcripts use the new sentences. Scripts that match the old transcript text should match on the new sentences, or run with `--debug`.
