---
"@namzu/cli": minor
---

An API key for a provider can now be saved once and kept. Namzu stores it in
`api-keys.json` in the Namzu home (created private to you and verified private after
writing, like the other credential files; Google keeps its own file), reads it after
the environment, and shows it as `saved API key · this device`. A key from an
environment variable still wins, so nothing you exported is replaced. Until now a key
pasted in the terminal picker was held for that session only; that path is unchanged,
but a key saved some other way is now found by every Namzu screen.

`namzu acp --desktop` advertises five new methods for the desktop app's Settings:
`namzu/providers/connections` (every provider and how it is connected, never a key),
`save_key`, `remove_key`, `test` (a cheap authenticated check, not a model turn) and
`refresh`. `DetectionSource` gains a `stored-api-key` kind and the provider status rows
may carry `anonymous: true` for the keyless free tier.

Removing the last saved key deletes `api-keys.json`; delete it by hand to forget keys
without the app.
