---
type: Guide
title: Sandbox egress profiles
description: A named, validated host allowlist with optional ports that means the same thing on the docker, runsc, firecracker and kubernetes backends; how each backend takes it, what each refuses at construction, the port union rule, and what a profile deliberately does not carry.
resource: packages/sandbox/src/egress/profile.ts
tags: [sdk, sandbox, egress, security, docker, kubernetes, firecracker]
status: draft
generated: { by: process:claude-code, at: 2026-09-21T00:00:00Z }
---

# Sandbox egress profiles

A `SandboxEgressProfile` is one named allowlist of hosts, each with optional
TCP ports, validated once by `defineEgressProfile` and handed to whichever
backend a host runs. The idea comes from the Gateway allowlist in google/ax
(`HostRule { host, port }`); the code is this package's own.

```ts
import { defineEgressProfile } from '@namzu/sandbox'

export const github = defineEgressProfile({
	name: 'github',
	hosts: [{ host: 'github.com' }, { host: '.githubusercontent.com' }],
})
```

## What a profile is

- **`name`** is a DNS-1123 label: lowercase letters, digits and `-`, at most 63
  characters. It becomes a pod label only where a host asks for that (see
  [kubernetes](#kubernetes)).
- **`hosts`** is the allowlist. `api.example.com` is that host; `.example.com`
  is that domain and every subdomain of it, the grammar `isHostAllowed`
  implements. An empty list means **no egress at all**.
- **`ports`** on a rule narrows that rule to those TCP ports. Absent means every
  port.

`defineEgressProfile` lowercases hosts, drops a trailing dot, sorts ports and
freezes the result. It refuses, with `SandboxEgressProfileError` naming the
field (`code`, `path`):

| Input | `code` |
|---|---|
| a name that is not a DNS-1123 label | `invalid-name` |
| `*`, a glob, a scheme, a path, `host:port`, an IP literal, `.com` | `invalid-host` |
| a port outside 1-65535, a non-integer, a repeated port, `ports: []` | `invalid-port` |
| the same host twice (after normalisation) | `duplicate-host` |

There is no wildcard entry and no fallback. ax falls back to `*:443` when a
workspace lists no hosts and continues after a failed apply; neither is taken.

## The port rule

When several rules match one host, the host may use the **union** of their
ports, and a matching rule with no `ports` allows every port.
`api.example.com [443]` beside `.example.com [8443]` lets `api.example.com` use
443 and 8443, and `www.example.com` use 8443 only. That is what Cilium does with
the rules that select a pod, and `egressProfileAllowsPort` is the one
implementation of it in this package.

```ts
import { defineEgressProfile, egressProfileAllowsPort } from '@namzu/sandbox'

const profile = defineEgressProfile({
	name: 'api',
	hosts: [
		{ host: 'api.example.com', ports: [443] },
		{ host: '.example.com', ports: [8443] },
	],
})

export const both: boolean =
	egressProfileAllowsPort(profile, 'api.example.com', 443) &&
	egressProfileAllowsPort(profile, 'api.example.com', 8443)
```

## Per backend

`createSandboxProvider({ egressProfile })` validates the profile and checks it
against the backend synchronously, before any I/O and before a backend is
built. Every refusal is a `SandboxEgressProfileError` with `backend` set.

| Backend | What the profile becomes | Refused |
|---|---|---|
| docker, runsc | `deny-all` for no hosts, otherwise a `static` allowlist through the egress proxy, which also enforces ports | a `brokeredCredentials` entry whose host the profile does not allow; ports on a proxy image without the `ai.namzu.egress-proxy.config="2"` label (at `create()`, before any container starts) |
| firecracker | `deny-all` for no hosts, otherwise the orchestrator's `allowlist` | any rule with `ports`: the orchestrator's network policy has no field for them |
| kubernetes | nothing: use `kubernetesEgressFromProfile` for `backend.egress` | any `egressProfile` on the provider |
| ACI standby pool | nothing | any profile: a claim carries no per-sandbox egress |

A profile beside `defaultEgress` is refused on every backend (`conflicting-policy`).
With no profile, every backend receives exactly what it did before.

### docker and runsc

The profile carries **no credentials**. Brokering exists only on the docker
egress proxy, so `ContainerBackendConfig.brokeredCredentials` stays where it
is; what a profile adds is a check that each credential's host is one the
profile allows, since the proxy would refuse every request such a credential is
for.

Ports are enforced by the egress proxy on the port it actually dials (443 for
an upgraded `http://host/` and for a portless `CONNECT`), before any brokered
credential is looked up. A profile with ports needs a proxy image rebuilt from
this version's `egress-proxy/Dockerfile`, which carries the label the backend
checks; see
[Container-tier egress](sandbox-egress.md#port-rules). A live
`setNetworkPolicy()` narrows the hosts, and the ports stay the profile's.

Under a profile, a live `setNetworkPolicy()` may narrow within the profile but
never widen past it. Each entry must be covered by a rule: a plain host by any
rule that matches it, and a `.domain` entry only by a `.domain` rule for the
same domain or a parent of it, because `api.example.com` in the profile never
listed the subdomains `.api.example.com` would admit. A call naming anything
else is refused (`invalid-host`, `path: allowedHosts[i]`) before it is queued.

### Kubernetes

The kubernetes backend enforces one config-level policy, and
`createKubernetesWorkspace` takes the backend config directly, so a
provider-level profile would never reach a workspace. The translator returns
the existing `KubernetesEgressConfig`, and putting it in `backend.egress` gives
task sandboxes and workspaces the same boundary:

```ts
import {
	createSandboxProvider,
	defineEgressProfile,
	kubernetesEgressFromProfile,
} from '@namzu/sandbox'

const profile = defineEgressProfile({
	name: 'github',
	hosts: [{ host: 'github.com', ports: [443] }, { host: '.githubusercontent.com', ports: [443] }],
})

export const provider = createSandboxProvider({
	backend: {
		tier: 'microvm',
		service: 'kubernetes',
		namespace: 'namzu-sandboxes',
		access: { inCluster: true },
		sandboxTemplateName: 'namzu-task',
		egress: kubernetesEgressFromProfile(profile, { engine: 'cilium' }),
	},
})
```

- No hosts becomes `policy: { kind: 'deny-all' }`; otherwise
  `{ kind: 'static', allowedHosts }`.
- Ports become `ciliumNarrowing.hostPorts`, keyed by the host as written, and
  need `engine: 'cilium'`; without it the translator refuses (`unsupported`).
  Cilium unions the per-host rules, which is the port rule above.
- A core engine with hosts is not refused by the translator: the backend's own
  `KubernetesUnenforceableEgressPolicyError` refuses it at wiring, as it does a
  hand-written config.
- **The profile name is not a pod label unless `profileLabel: true`.** With the
  label off, the output is exactly the hand-written config. With it on, the
  default policy object becomes `${template}-${profile}-egress`, a stock
  controller refuses the claim until an operator adds the key's domain to
  `allowed-label-domains`, and an existing workspace without the label stops
  adopting. `profileLabelKey` without `profileLabel: true` is refused.
- `dnsNames` is forwarded as `ciliumNarrowing.dnsNames`; on a profile with no
  hosts it is refused rather than ignored.

## What a profile does not carry

- **Credentials.** See [docker and runsc](#docker-and-runsc).
- **A registry, a file format or a `~/.namzu` key.** A host that has several
  profiles keeps its own map; nothing in the CLI builds an `@namzu/sandbox`
  provider today.
- **A change to `EgressPolicy` or `SandboxBackendOptions`.** Custom backends
  still read `SandboxBackendOptions.egress`, and a profile reaches them as the
  policy it becomes.
