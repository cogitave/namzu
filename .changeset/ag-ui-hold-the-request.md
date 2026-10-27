---
'@namzu/ag-ui': patch
---

A client that disconnects or cancels mid-run now always stops the turn. Before, `adapter.handle(request)` let go of the `Request` once it had read the body, and the platform ties a request's `signal` to the caller's signal through a weak reference; if a garbage collection ran between the first streamed token and the cancel, the cancel never reached the provider stream and the run kept going until the model finished. The adapter now keeps the `Request` for as long as the run lasts. Nothing to change on your side; a host that passes its own `Request` and drops it is covered too.
