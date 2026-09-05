---
"@namzu/sdk": major
"@namzu/cli": major
"@namzu/sandbox": major
---

Kernel ID factories, file-lock IDs and SDK-managed Docker/ACI sandbox IDs now generate UUID v4 strings instead of prefixed random strings. Nominal TypeScript entity brands remain, but their underlying type is an opaque string rather than a prefixed template literal. Before upgrading, remove prefix parsing and prefix-only validators in consumers; use checked constructors or the new `isEntityId(value, kind)` predicate and validate ownership through store records. Public Project, Run and Message schemas accept only UUIDs while remaining Zod string schemas. External sandbox/orchestrator IDs retain their service-defined contracts.

`InvalidIdError.expectedKind` replaces `expectedPrefix`; hosts displaying validation errors must read the entity kind instead. Built-in HTTP/webhook connector IDs and the default shell-hook plugin ID are now stable UUIDs.

Prefixed records, including formerly accepted safe prefixes, are no longer admitted. Constructors, schemas and disk readers require UUIDs. No automatic migration or deletion is performed. Supply UUIDs for custom IDs and use a fresh dedicated application home when previous state is no longer needed. Do not downgrade UUID stores to a prefix-only reader.

In-memory session and topic stores accept existing Project/Topic snapshots without creating replacement identities. The CLI uses this to bind delegation to the actual parent run, conversation, project and tenant. Child artifacts now live beneath the owning Project's `subagents/sessions` tree, without another generated Project layer. Scripts inspecting the old nested subagent layout must follow the new paths for new children; historical artifacts remain in place. Completed parent runs release their delegated children and bookkeeping. Tasks default to the actual invoking run instead of `run_namzu-cli`.

CLI state selectors, session maps and transcript export require UUIDs; export skips the reserved emergency-snapshot directory. Emergency-to-checkpoint projection uses the snapshot's existing UUID. The CLI always selects the checkout-root binding, even when an older directory-specific Project exists. Historical records are left in place and are not merged. Durable `drain` now requires an authoritative persisted Session and takes its Topic from that record; checkpoint-only hosts must persist the Session metadata before draining.
