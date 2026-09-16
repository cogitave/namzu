---
"@namzu/sandbox": patch
---

The shipped Kubernetes sandbox host `Role` (`packages/sandbox/k8s/manifests/rbac.yaml`) now grants `get` on `ciliumnetworkpolicies` (`cilium.io`), matching what `docs/sdk/kubernetes-sandbox.md`'s RBAC section already documented.

Before: the Role granted `get` on `networkpolicies` (`networking.k8s.io`) only. A deployment configuring `config.egress.engine: 'cilium'` has `verifyEgressPolicyConfigured` read a `CiliumNetworkPolicy` instead, before every `createKubernetesWorkspace` call and a provider's first `create()` — so the shipped Role 403'd on exactly the path the docs said it covered.

A cluster with no Cilium CRDs installed simply never matches the added rule, so this changes nothing for the default `'core'` engine. No code, type or default changed — patch.
