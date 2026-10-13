---
"@namzu/cli": minor
"@namzu/desktop": minor
"@namzu/sdk": patch
---

Models work on first open with nothing to set up. With nothing saved, Namzu Desktop and the terminal app now start on what they find, in this order: a sign-in Namzu already reuses (Claude Code, Codex), an API key in the environment, a local server (Ollama on port 11434, LM Studio on port 1234; each probe waits at most 300 ms and they run together), then the keyless Zen free models. They say what they picked in plain words ("Using your Claude sign-in, found on this computer.") and save nothing, so a key or sign-in added later wins on the next open. `/model` and the model picker change it.

What changes for you: in the terminal app a first run with an API key or a local server in the environment no longer stops at the provider picker; it starts on that provider. The picker still opens when nothing is available. In Desktop the keyless Zen free models now count as usable, as they already did in the terminal app, so a new person's message box is ready and Send works at once; the "Add an API key or sign in to start" card now appears only when nothing at all is available. To keep the old terminal behaviour of choosing yourself, save a choice once with `/model`.

When Zen declines a free request that carried no key, both apps now say "Zen didn’t accept the free model right now. Try again in a while, or choose another provider. A Zen API key also works." and keep the technical detail under Details (Desktop) or `--debug` (terminal). The generic `provider.permission` explanation in `@namzu/sdk` no longer says the key authenticated: a 403 only says the request was refused.
