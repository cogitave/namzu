---
'@namzu/sdk': patch
---

The coding-agent working doctrine now tells the model never to change git configuration (`user.name`/`user.email`, hooks, remotes, credential helpers) or other persistent settings without asking. When a commit fails because no identity is set, it tells you the command instead of inventing an identity.
