---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Expose live tool progress and actual turn failure messages through optional fields on existing ACP update variants. Add explicit optional `namzu/*` ACP host extensions and advertise their method names. Gateway history loading now receives the requested workspace as an optional second argument; existing one-argument gateways remain compatible.

The CLI now loads durable, project/tenant-scoped ACP conversations and refuses archived writers. `namzu acp --desktop` enables operator methods for folder trust, scoped conversation/history, safe provider metadata and background jobs. Ordinary ACP connections retain the core method set. The private desktop preview uses this existing runtime and log rather than a second conversation store.
