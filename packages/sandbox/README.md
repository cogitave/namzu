# @namzu/sandbox

Pluggable sandbox provider for [`@namzu/sdk`](../sdk). Four tiers,
each backed by the industrial-standard primitive for that
deployment shape. Same `SandboxProvider` surface the SDK consumes
across all of them — swapping tiers is a config change, not an
integration rewrite.

## Tier matrix (2026 industrial standard)

| Tier | Use case | Primitive | Cold-start | Local dev |
|---|---|---|---|---|
| `process` | Agent runs on the developer's own host (Claude Code-style "don't read `~/.ssh`") | bubblewrap (Linux/WSL2) or Seatbelt (macOS), via [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime) | Process spawn (~ms) | Native — no infra |
| `container` (`docker`) | App in `docker compose` locally or single-tenant prod replica | OCI container, seccomp default profile, tmpfs workdir, no-network default | 0.5–2s | `docker compose up` |
| `container` (`runsc`) | Trusted-tenant SaaS — what OpenAI Code Interpreter and [Modal](https://modal.com/blog/gvisor-savings-article) ship | Google [gVisor](https://gvisor.dev/docs) userspace kernel as Docker runtime | container start + ~100ms | Linux Docker only (no Docker Desktop on macOS) |
| `microvm` (`e2b`) | Adversarial multi-tenant SaaS, Python-REPL workloads | Firecracker microVM via [E2B](https://e2b.dev/docs/sandbox) managed service | ~150ms (snapshot/restore) | E2B API key from any laptop |
| `microvm` (`fly-machines`) | Adversarial multi-tenant SaaS, arbitrary tool-call workloads | Firecracker microVM via [Fly Machines](https://fly.io/docs/machines) | 250ms–1s | Fly API token from any laptop |
| `microvm` (`self-hosted`) | Same threat model, host insists on owning the scheduler | [`firecracker-containerd`](https://github.com/firecracker-microvm/firecracker-containerd) on KVM-enabled Linux | <300ms with snapshot restore | Lima/Colima Linux VM on macOS |
| `passthrough` | Tests and explicitly trusted environments | Direct host process — no isolation | n/a | n/a |

## Why these tiers (and not others)

The 2026 consensus across production agent platforms (AWS
Lambda/Fargate, Fly Machines, Replit, E2B, Modal, OpenAI Code
Interpreter, Anthropic Code Execution, Daytona) bifurcates cleanly
along the **trust boundary**:

- **Adversarial multi-tenant code execution → Firecracker microVMs.**
  AWS, Fly, Replit, E2B, Daytona all converged here. The argument
  is in [Fly's "Sandboxing and Workload Isolation"](https://fly.io/blog/sandboxing-and-workload-isolation)
  and the [original Firecracker paper](https://www.usenix.org/conference/nsdi20/presentation/agache):
  KVM-backed VMs are the only mainstream primitive with a
  kernel-level trust boundary, and `jailer` plus snapshot/restore
  makes them boot in 125ms.
- **Trusted-tenant or first-party workloads → gVisor.** Google's
  GKE Sandbox, Modal, OpenAI Code Interpreter run gVisor's `runsc`.
  Near-zero cold-start, runs on commodity Linux without nested
  virt. Tradeoff: a userspace-kernel CVE is a tenant escape; a
  Firecracker CVE generally is not.
- **Single-user dev workstation → bubblewrap / Seatbelt.** What
  Anthropic itself ships with Claude Code via
  `@anthropic-ai/sandbox-runtime`. The threat model is "don't let
  the agent read `~/.ssh` or run `rm -rf ~`," not "tenant A vs
  tenant B." Process-spawn cold-start.
- **Single-tenant or co-trusted tenants → plain Docker + seccomp.**
  Northflank, Railway, Render, Compass-platform, GitHub Actions
  runners. Adequate when the model is your model and the user is
  your customer; insufficient when the prompt is the attacker.

`@namzu/sandbox` exposes all four as separate tiers so the host
picks the trust boundary that matches its threat model.

**What we deliberately do NOT build** is yet-another Firecracker
scheduler. That is E2B's and Fly's entire product, and writing
our own would be a years-long detour. We adapt to theirs and
reserve the `self-hosted` option for hosts that need to own the
scheduler for compliance or air-gap reasons.

## Cloud portability

The interface is cloud-agnostic. `docker` works on every cloud,
`e2b` and `fly-machines` are managed services not tied to any
cloud, `runsc` and `firecracker:self-hosted` need infrastructure
the host chooses (GKE Sandbox, AWS Fargate, self-hosted KVM, etc.).
Picking a stronger backend may imply picking a different cloud —
that's the host's call, not the SDK's.

## Egress allowlist policy

Every backend supports the same `EgressPolicy` shape:

```ts
type EgressPolicy =
  | { kind: 'deny-all' }                                              // default
  | { kind: 'allow-all' }                                             // tests only
  | { kind: 'static'; allowedHosts: readonly string[] }
  | { kind: 'resolver'; resolve: () => Promise<readonly string[]> }
```

The `resolver` shape is **parameterless on purpose**. Hosts that
need per-tenant policies bake the tenant identity into the closure
that constructs the provider — exactly how compass-platform's
JWT-minting flow already works (the server knows the tenant when
it issues the JWT, the allowlist claim is baked in there). This
avoids the "where does the resolver get its context from"
plumbing problem; the host owns the closure, the SDK runtime
doesn't have to forward identity through `provider.create`.

## Status

This package is being built out across the `ses_004-native-agentic-runtime-and-sandbox`
design session in phases. Each phase ships one tier, fully
implemented + tested + documented:

- ✅ **P3.0** — Public surface (this commit). Backend interfaces,
  tier discriminator, egress policy. Factory throws
  `SandboxBackendNotImplementedError` until backends land.
- ⏳ **P3.1** — `container:docker` backend. Universal local-dev
  default; ships first.
- ⏳ **P3.2** — `EgressPolicy` plumbing + reference egress proxy
  (compass-platform pattern: HTTP CONNECT tunnel + JWT-claim
  allowlist).
- ⏳ **P3.3** — `microvm:e2b` and `microvm:fly-machines` adapters.
  Phase 2 production tier.
- ⏳ **P3.4** — `process` backend (Anthropic sandbox-runtime
  adapter — bubblewrap/Seatbelt).
- ⏳ **P3.5** — `container:runsc` (gVisor) and
  `microvm:self-hosted` (firecracker-containerd). Phase 3
  adversarial-multi-tenant.

The interface here is what every backend implements; the staged
rollout is purely about turning each tier on, not about reshaping
the contract.

## Usage (post-implementation)

```ts
import { createSandboxProvider } from '@namzu/sandbox'

// Phase 1: ship now, works on every dev's laptop
const sandbox = createSandboxProvider({
  backend: { tier: 'container', runtime: 'docker', image: 'namzu-worker:latest' },
  defaultEgress: { kind: 'static', allowedHosts: ['api.openai.com', 'api.anthropic.com'] },
})

// Phase 2: production, adversarial multi-tenant, managed Firecracker
const sandbox = createSandboxProvider({
  backend: { tier: 'microvm', service: 'e2b', apiKey: process.env.E2B_API_KEY! },
  defaultEgress: {
    kind: 'resolver',
    resolve: async () => fetchAllowlistForTenant(tenantId),
  },
})

// Phase 3: adversarial multi-tenant, self-hosted Firecracker on KVM
const sandbox = createSandboxProvider({
  backend: {
    tier: 'microvm',
    service: 'self-hosted',
    firecrackerBinary: '/usr/local/bin/firecracker',
    kernelImage: '/var/lib/namzu/vmlinux',
    rootfsImage: '/var/lib/namzu/rootfs.ext4',
  },
})

// Wire into drainQuery / agent run config:
//   sandboxProvider: sandbox
```
