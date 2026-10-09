---
'@namzu/desktop': minor
---

You can now connect a provider from inside the app. When nothing can answer yet, the composer says "Add an API key or sign in to start" with one button that opens Settings ▸ Models, instead of letting your first message fail. Models lists each provider and how it is connected (a key in your environment, a key you saved, an existing Claude or ChatGPT sign-in, a local server, the free tier), lets you paste a key, check it and remove it. The key is saved by the Namzu command line in its own private file and is never kept in the window.

Failures now read in plain words with a next step: a rejected key opens Settings, a provider outage says your message is saved, a rate limit shows "Waiting for Anthropic to accept more requests… retrying in 6s" instead of a silent Working, a stopped reply that cannot be repeated offers a new conversation, and the provider's own message sits behind Details. A folder deleted while open says it can't be found and offers Locate folder or Remove project; a crashed connection keeps your conversation on screen, reconnects once by itself and clears its own error; an engine that cannot start is named and its button no longer shows an empty bar. Approval cards say what they would replace.
