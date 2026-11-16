---
'@namzu/cli': minor
---

`namzu exec --model <id>` and `exec --provider <id>` no longer drop the account saved for that provider. Before, a person whose OpenRouter (or any other) account was set in `preferences.json` got an error asking for the provider's environment key as soon as they picked a model on the command line; now the run keeps that account, and the same holds for `exec --json` and for a model chosen from an ACP client. `exec` also takes `--account <label>` (or `provider:label`), like the interactive session, and refuses an account that belongs to another provider than `--provider` or that does not exist. Nothing to change on your side; a provider with no saved account still uses its usual sign-in.
