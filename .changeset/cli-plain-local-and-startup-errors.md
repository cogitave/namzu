---
"@namzu/cli": patch
---

The terminal app no longer tells you to check your internet connection when a server on your own computer or network (Ollama, LM Studio, a local address) is down: it names the server and says to start it. Startup problems (the working folder, saved data, plugins, computer use, the browser) now print one plain sentence, with the error text shown only under `--debug` as "Details:". The setup screen says how a credential was found in words ("Signed in with Codex") instead of an internal name, and a long folder name in CJK or with emoji is shortened by its display width. Nothing to change on your side; scripts that matched the old `Working directory is unavailable` or `Failed to construct <provider>` text should match the new sentences.
