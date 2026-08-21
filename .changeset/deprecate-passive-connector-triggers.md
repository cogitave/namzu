---
'@namzu/sdk': minor
---

Deprecate `ConnectorDefinition.triggers`, `ConnectorTrigger`, and
`ConnectorEvent`. The SDK has never subscribed to these declarations, emitted
their event shape, or started a run from them. Existing hosts may continue to
read trigger metadata back from `ConnectorRegistry` during this migration
release.

Move inbound subscription metadata and the event envelope into the host that
owns delivery before the next SDK major. That host must continue to own
de-duplication, claim recovery, trust, and run admission; registering a trigger
with Namzu does not activate an inbound event path.
