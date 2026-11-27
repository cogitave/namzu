---
'@namzu/sdk': minor
---

The common-layout reader's `mcp-needs-setup` finding gains a `server` field (`{ name, kind: 'local' | 'remote' }`) so a host can list a remote server that is not usable yet without parsing the message, and a plugin whose only content is such a remote server now loads and reports it instead of being refused as having nothing Namzu uses. The `mcp-server-remote` message says the server connects only after the person approves it. Nothing existing breaks; the field is optional and no other finding changes.
