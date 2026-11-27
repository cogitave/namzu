---
"@namzu/sdk": minor
---

A `mcp-needs-setup` finding from the common plugin layout reader now carries the server as written (`server`, type `LayoutSetupServer`), so a host can still show a server that is not admitted yet. Nothing existing changes; the field is new and optional.
