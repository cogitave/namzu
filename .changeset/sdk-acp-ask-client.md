---
'@namzu/sdk': minor
---

New on `ACPServer`: `askClient(method, params, signal?)` sends the client one request named `namzu/...` and returns its answer (it rejects with the client's own words, and when the connection closes first), and `clientOffers(capability)` says whether the client named a capability at `initialize`. A host extension that needs the client to do something uses them; nothing changes for a host that does not.
