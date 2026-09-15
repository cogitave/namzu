---
"@namzu/sandbox": minor
---

A Kubernetes backend that claims VM-isolated sandboxes out of an [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) warm pool. New exported types `KubernetesBackendConfig` and `KubernetesClusterAccess`; `SandboxBackendConfig` and `SandboxProviderConfig` each gain an arm for it, so `createSandboxProvider({ backend: { tier: 'microvm', service: 'kubernetes', … } })` type-checks with no cast. Nothing existing changes shape.

**Take this upgrade for the new backend, not for a complete one.** This batch implements acquire, readiness, address resolution and teardown. The execution surface does not exist yet: `exec`, `readFile`, `writeFile` and `listFiles` on a sandbox from this backend throw `KubernetesAgentTransportPendingError`, which names the missing guest transport rather than failing as an absent method. `destroy()` is real. Workspace suspend/resume, egress mapping and the cluster manifests follow in later releases. Every other backend is untouched.

What it does today, on a cluster running agent-sandbox v1.0.2 with a VM-isolating `RuntimeClass`:

- **Warm claim, or a direct Sandbox.** With `warmPoolName`, `create()` POSTs a `SandboxClaim` at that pool and the controller binds an already-running sandbox. Without it, it POSTs a `Sandbox` built from `sandboxTemplateName`'s pod template — necessitated rather than offered, since `SandboxClaim.spec.warmPoolRef` is required and a pool-less claim does not exist in the API.
- **The claim is pristine.** `spec.env` and `spec.volumeClaimTemplates` are never set, because a claim carrying either is forced to cold-start upstream instead of adopting a pool sandbox. It would still work; it would just stop being fast. Per-sandbox `env`, `memoryLimitMb`, `maxProcesses` and `egress` are therefore refused by name instead of accepted and dropped — set them on the `SandboxTemplate` the pool is built from.
- **The bound sandbox's own identity.** A pool sandbox keeps the name the pool generated for it, so the backend reads `status.sandbox` back rather than assuming the claim's name; the sandbox `id` is that cluster name, which makes an id in a log line a `kubectl get sandbox` argument.
- **Nothing left behind.** Every created object carries an absolute `shutdownTime` (default one hour, `claimTtlSeconds`) plus `shutdownPolicy: Delete`, so a host that dies mid-run costs one expiry rather than a leaked sandbox — `ttlSecondsAfterFinished` deliberately is not used, because its timer starts from a `Finished` condition a crashed host never reaches. Every failure on the create path deletes what it created on a separate short budget; an object already gone counts as released.
- **A per-instance agent credential.** The pod's own `metadata.uid`, read with one `GET` after readiness and delivered to the guest through the downward API. No claim mutation, so the warm path stays pristine.

Credentials arrive through `access`: `{ inCluster: true }` reads the projected ServiceAccount volume, and anything else supplies `{ server, ca?, getToken }`. There is no kubeconfig parsing in the package and no new dependency — `@namzu/sandbox` still declares no `dependencies` key.
