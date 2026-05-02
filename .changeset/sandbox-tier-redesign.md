---
'@namzu/sandbox': minor
---

feat(sandbox)!: tiered backend taxonomy aligned with 2026 industrial standard

Restructures the public surface from a flat backend-tag list into a
four-tier taxonomy that mirrors how production agent platforms
actually deploy code-execution sandboxes:

- `process` — Claude Code-style host-process isolation
  (bubblewrap on Linux, Seatbelt on macOS, via Anthropic's
  `@anthropic-ai/sandbox-runtime`). For agents that run on the
  developer's own machine.
- `container` — OCI container per task. Two runtime options:
  `docker` (default, universal local-dev fallback; what
  Northflank/Railway/Render/Compass-platform/GitHub Actions
  runners ship) and `runsc` (Google gVisor, trusted-tenant tier;
  what OpenAI Code Interpreter and Modal Labs ship).
- `microvm` — Firecracker microVM per task, three concrete
  services: `e2b` (managed, ~150ms cold-start via snapshot
  restore), `fly-machines` (managed, closer to bare-metal), and
  `self-hosted` (`firecracker-containerd` on KVM-enabled Linux for
  hosts that need to own the scheduler).
- `passthrough` — no isolation; for tests and explicitly trusted
  environments.

Each tier carries a tier-specific config shape (discriminated union
on `tier`); picking a tier picks the shape automatically via TS
narrowing. Industrial precedent for every choice is cited in the
package README:

- Adversarial multi-tenant → Firecracker microVMs (AWS Lambda /
  Fargate, Fly Machines, Replit, E2B, Daytona — Fly's
  "Sandboxing and Workload Isolation" post and the original
  Firecracker NSDI '20 paper are the canonical refs).
- Trusted-tenant → gVisor (GKE Sandbox, Modal, OpenAI Code
  Interpreter — `gvisor.dev/docs/architecture_guide/security` is
  the reference).
- Single-user developer machine → bubblewrap / Seatbelt
  (Anthropic Claude Code — `anthropic-experimental/sandbox-runtime`).
- Single-tenant or co-trusted → plain Docker + seccomp default
  profile.

We deliberately do NOT build our own Firecracker scheduler — that
is E2B's and Fly's entire product, and writing our own would be a
years-long detour. The `microvm` tier adapts to theirs and
reserves `self-hosted` for compliance/air-gap deployments.

`EgressPolicy.resolver` is now parameterless
(`() => Promise<string[]>`). Per Codex's stop-time review, the
prior shape took a `EgressResolveContext` with `tenantId` /
`runId` / `agentId` fields the SDK runtime had no way to populate,
so the resolver context was permanently unreachable. Hosts that
need per-tenant policies bake the tenant into the closure that
constructs the provider — exactly how compass-platform's
JWT-minting flow already works.

Same reason for dropping `tenantId` / `runId` / `agentId` from
`SandboxBackendOptions`: a contract the runtime can't fulfill is
worse than not having it.

**Breaking** for consumers of the still-pre-1.0 surface introduced
in the previous skeleton commit (no implementations existed yet,
so realistic migration cost is zero).

Phase plan unchanged in structure but renumbered for clarity:
P3.1 ships `container:docker` first (works locally and in any
cloud), P3.2 the egress proxy, P3.3 the `microvm` managed adapters,
P3.4 the `process` tier, P3.5 the adversarial-multi-tenant tier.
