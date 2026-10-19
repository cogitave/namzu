---
"@namzu/cli": minor
---

Conversations are now named by a small model, as in the reference terminal. After the first message of a conversation, one extra request (no tools, 60 tokens) asks a small model for a two-to-five-word, sentence-case noun phrase in the message's language, and `/resume` lists the conversation under it instead of under your first sentence. A name you chose with `/rename` is never replaced, and removing it falls back to the first message. If the request fails nothing is shown and the first message stays the title.

What changes for you:

- The request runs on `smallModel` when it is set in your user or managed config (`provider/model`, or a model id at the active provider; never read from a project's `namzu.config.json` or the environment), otherwise on the cheapest priced text model the active provider lists, otherwise on the conversation's own model. Its tokens are counted on the turn's token ledger. To choose where the text goes, set `smallModel`. There is no setting that turns the title request off; set `smallModel` to a model you are happy to spend on.
- A conversation started in Desktop is not named by the model yet; Desktop lists the stored title of one started in the terminal.
