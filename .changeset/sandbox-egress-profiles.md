---
"@namzu/sandbox": minor
---

New: egress profiles. `defineEgressProfile({ name, hosts: [{ host, ports? }] })`
validates one named host allowlist, and `createSandboxProvider` takes it as
`egressProfile` instead of `defaultEgress`. On docker, runsc and firecracker a
profile becomes `deny-all` (no hosts) or a `static` allowlist. Whatever a
backend cannot honour is refused at construction with
`SandboxEgressProfileError`: ports on docker, runsc and firecracker, any
profile on the ACI standby pool or beside `defaultEgress`, and a
`brokeredCredentials` host the profile does not allow. On docker and runsc a
live `setNetworkPolicy` under a profile may only name hosts the profile covers.
On kubernetes, `createSandboxProvider` refuses `egressProfile`; put
`kubernetesEgressFromProfile(profile, { engine: 'cilium' })` in
`backend.egress` instead, which also bounds workspaces and writes the profile
label only with `profileLabel: true`.

Nothing changes for a config without `egressProfile`.
