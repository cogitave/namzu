---
'@namzu/sdk': minor
---

Harden the MCP boundary: the host decides what enters the tool registry,
and a server that changes its mind is noticed.

- `MCPToolDiscovery` takes per-server `allow`/`deny` policies (`'*'` for
  servers without an entry). Discovery previously admitted whatever the
  server offered, which put the REMOTE side in charge of what the agent
  can call — the exact inversion of least privilege. Deny beats allow, so
  a self-contradicting config resolves restrictively.
- Drift detection: the admitted tool set is fingerprinted (name +
  description + input schema) and compared on each discovery, with an
  `onDrift` callback reporting `added` / `removed` / `changed`. The
  fingerprint covers descriptions and schemas, not just names, because the
  attack shape is advertising something benign at approval time and
  swapping its meaning afterwards — the name never moves. Reported rather
  than blocked: a dev server legitimately changes between runs, and only
  the host knows which kind it is looking at.
- Protocol negotiation is checked. A server answers `initialize` with the
  version IT will speak; the client ignored that answer entirely, so a
  version it could not speak looked like a healthy connection until
  something downstream broke oddly. It now refuses a version outside
  `MCP_SUPPORTED_PROTOCOL_VERSIONS` and names what it can speak. An
  ABSENT version is still tolerated — a missing field is a sloppy server,
  an unsupported version is a real incompatibility.

`MCP_PROTOCOL_VERSION` deliberately stays at the version namzu actually
implements. Advertising a newer one whose requirements are unimplemented is
worse than advertising an older one honestly, because the server tailors
its behavior to the claim. Raising it is a conformance task.

Hosts that configure no policy see no behavior change.
