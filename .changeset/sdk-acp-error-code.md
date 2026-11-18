---
'@namzu/sdk': patch
---

`ACPServer` sends a gateway error's stable code as the JSON-RPC error's `data: { code }`. A gateway attaches it by throwing an error with a `data: { code: 'some-name' }` property (a short lower-case name); nothing else on the error is sent, and an error without one is answered as before.
