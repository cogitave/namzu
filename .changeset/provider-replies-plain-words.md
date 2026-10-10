---
"@namzu/cli": patch
"@namzu/desktop": patch
---

Provider failures and key checks in the desktop app read in plain words. A model the account cannot use no longer blames the key, and an account out of credit, a timeout, a missing model and an oversized message each say what happened. The CLI host's `namzu/providers/test` can now answer an unchecked key with a `cause` (`quota`, `busy`, `down`, `no-answer`); callers that ignore it behave as before. The model list's failure sentences name the provider, and the signed-out Codex message now reads "Codex needs you to sign in with its own account."
