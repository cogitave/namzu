# @namzu/sandbox

Pluggable sandbox provider for [`@namzu/sdk`](../sdk). One package,
multiple backends, same `SandboxProvider` surface the SDK consumes.

```ts
import { createSandboxProvider } from '@namzu/sandbox'

const sandbox = createSandboxProvider({
  backend: 'process', // or 'container' | 'passthrough'
  defaultEgress: { kind: 'static', allowedHosts: ['api.openai.com', 'api.anthropic.com'] },
})

// Wire into drainQuery / agent run config:
//   sandboxProvider: sandbox
```

## Backends

| Backend | What it isolates | When to use |
|---|---|---|
| `process` | A single host process — bubblewrap on Linux, Seatbelt (`sandbox-exec`) on macOS, plus an HTTP/SOCKS proxy outside the sandbox enforcing a domain allowlist. The model Anthropic ships in [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime). | Developer dev loops where the agent runs on the user's actual machine and you want a low-overhead "don't read /etc, don't dial evil.com" guard. Cold-start is process spawn (~ms). |
| `container` | A whole worker container per task — the worker speaks HTTP to the host, an egress-proxy sidecar mediates outbound network with JWT-authenticated allowlists, the container's filesystem is the sandbox. The pattern cogitave/compass-platform deploys today. | Multi-tenant production where the host process must NOT trust the agent at all. Cold-start is seconds (container start) but blast radius is bounded by the kernel's container boundary. |
| `passthrough` | Nothing. Runs commands directly. | Tests and trusted environments only. Off by default; opt-in. |

## Why these backends and not gVisor / Firecracker / microsandbox?

Per the [ses_004 design session](../../docs.local/sessions/ses_004-native-agentic-runtime-and-sandbox/README.md) research:

- **gVisor** needs the `runsc` runtime; not available on Azure Container Apps. Breaks dev/prod parity.
- **Firecracker** / **Kata** / **microsandbox** need KVM; same problem.
- **bubblewrap + Seatbelt** is what Anthropic itself ships with Claude Code. Same code path runs under `docker compose up` locally and on a Linux replica in production.
- **Container** backend gives an additional "host doesn't trust agent at all" tier for multi-tenant deployments without introducing a new isolation tech the SDK has to vendor.

## Egress allowlist policy

Every backend supports the same `EgressPolicy` shape:

```ts
type EgressPolicy =
  | { kind: 'deny-all' }                                                 // default
  | { kind: 'allow-all' }                                                // tests only
  | { kind: 'static'; allowedHosts: readonly string[] }
  | {
      kind: 'resolver';
      resolve: (ctx: EgressResolveContext) => Promise<readonly string[]>;
    }
```

Resolver shape lets the host re-evaluate the allowlist per run based on `tenantId` / `runId` / `agentId` — the compass-platform pattern. Static is fine when the allowlist doesn't depend on run identity.

## Status

This package is being built out across the `ses_004-native-agentic-runtime-and-sandbox` design session in phases:

- ✅ **P3.0** — Public surface (`SandboxBackendKind`, `SandboxBackend`, `EgressPolicy`, `createSandboxProvider`). All `createSandboxProvider` calls currently throw `SandboxBackendNotImplementedError` until backends land.
- ⏳ **P3.1** — `process` backend (Anthropic sandbox-runtime adapter).
- ⏳ **P3.2** — Egress allowlist policy plumbing.
- ⏳ **P3.3** — `container` backend (compass-pattern reference Dockerfile).
- ⏳ **P3.4** — Vandal Cowork consumes this package.

The interface here is what every backend implements; the staged rollout is purely about turning it on, not about reshaping it.
