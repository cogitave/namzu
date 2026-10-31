---
'@namzu/cli': patch
---

Adds the reader that signs a request with an extra Codex account kept in its own private folder, refreshing its tokens in place under a per-account lock. Nothing in the app calls it yet, so there is no change to sign-in, `/login` or any existing credential.
