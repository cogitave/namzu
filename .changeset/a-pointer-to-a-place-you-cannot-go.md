---
'@namzu/computer-use': patch
'@namzu/sandbox': patch
'@namzu/cli': patch
'@namzu/sdk': patch
---

Remove references that pointed readers at a directory they can never open.

Agent working memory in this repository is gitignored, and several published
artifacts cited paths inside it. None of them resolved for anyone but the
maintainer, and four cited session folders that no longer exist at all.

What a consumer sees change:

- `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
  progress in vendor/namzu/docs.local/sessions/ses_004-...` — a runtime error
  instructing the reader to open a path that is not in the package, not in the
  repository, and not on the internet. It now names what does ship instead.
- `@namzu/computer-use`'s README linked to an adapter-pattern document under a
  directory that does not exist in any checkout. It now links to the two
  published pages that actually carry the adapter contract, the capability
  protocol, and the platform command matrix.
- `@namzu/cli`'s README linked to a session folder on the code host that
  returns 404, to explain the doctor's protocol/runtime split. The split is now
  explained in the sentence itself.
- `@namzu/sdk` source comments cited design documents by path. They cite the
  session by name instead, which is what the reference was ever worth.

No API, type, or behaviour change. The `@namzu/sandbox` message text is the
only runtime string affected, and nothing asserts on it.
