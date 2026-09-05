---
"@namzu/sdk": major
"@namzu/cli": major
"@namzu/sandbox": major
---

Kernel ID factories, file-lock IDs and SDK-managed Docker/ACI sandbox IDs now generate UUID v4 strings instead of prefixed random strings. Nominal TypeScript entity brands remain, but their underlying type is an opaque string rather than a prefixed template literal. Before upgrading, remove prefix parsing and prefix-only validators in consumers; use checked constructors or the new `isEntityId(value, kind)` predicate and validate ownership through store records. Public Project, Run and Message schemas accept UUIDs and safe matching legacy IDs while remaining Zod string schemas. External sandbox/orchestrator IDs retain their service-defined contracts.

Existing safe prefixed records retain their keys, and disk readers support mixed legacy/UUID hierarchies. Existing ambiguous `thd_` and unsafe custom IDs remain unsupported. No automatic record migration is performed. Older prefix-only readers cannot read newly generated UUID records; avoid downgrading stores containing them.

In-memory session and topic stores accept existing Project/Topic snapshots without creating replacement identities. The CLI uses this to bind delegation to the actual parent run, conversation, project and tenant. Child artifacts now live beneath the owning Project's `subagents/sessions` tree, without another generated Project layer. Scripts inspecting the old nested subagent layout must follow the new paths for new children; historical artifacts remain in place. Completed parent runs release their delegated children and bookkeeping. Tasks default to the actual invoking run instead of `run_namzu-cli`.

CLI state inventory, session maps and transcript export recognize both ID formats; export skips the reserved emergency-snapshot directory. Emergency-to-checkpoint projection retains stable legacy mappings and uses a UUID emergency snapshot's existing UUID for new snapshots.
