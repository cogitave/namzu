---
"@namzu/cli": minor
---

An API key you add with `/auth` is now stored once, in `accounts.json`, instead of also being copied into `api-keys.json`. Startup finds it from the account, so nothing changes for you. A copy an earlier version left behind is removed at the first start, only when it is exactly the account's key, with a one-line notice; a different key is kept. Removing an account removes its key, and `/logout <provider>` also removes that provider's plain `/auth` accounts. An older version started afterwards still finds the key in the account.
