---
"@namzu/sdk": major
---

Make connector credentials tenant- and connector-authorized instead of
globally authorized by credential id. Custom `CredentialVault`
implementations must add atomic `retrieveForScope(tenantId, connectorId, id)`
and `revokeForTenant(tenantId, id)` operations; keep `retrieve(id)` and
`revoke(id)` only for callers that intentionally hold host-wide vault
authority. `TenantConnectorManager.revokeCredential` now requires `tenantId`,
and credential plus connector-instance identity fields are readonly snapshots.

`ConnectorDefinition.supportedAuth` is now enforced. Align a concrete
connector's declaration with its registered definition, include `none` when an
unauthenticated connection is valid, and declare every scheme it can consume.
Unsupported explicit credentials are refused before instance publication and
late credentials are rechecked before connection. Existing live instances keep
the auth policy captured at creation instead of following later registry
replacement.
