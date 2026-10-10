---
"@namzu/cli": patch
---

The terminal app no longer shows a provider's or program's own text where a plain sentence belongs. A model list that could not be fetched says, for example, "OpenAI rejected the saved API key. Press Esc, then k to enter a new key."; a key the provider rejects says so without the provider's message; provider setup shows "Installed · version 0.46.0" or "Couldn’t check Codex. Details: --debug" instead of the program's warning lines; and the folder trust prompt writes the folder with `~` and a middle ellipsis that keeps the last folder whole. The raw text is still available with `--debug`. Nothing to change on your side.
