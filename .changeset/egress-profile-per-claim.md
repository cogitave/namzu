---
'@namzu/sandbox': minor
---

The Kubernetes backend can now select an egress PROFILE per claim, so one
`SandboxWarmPool` serves several enforced network modes. **It needs an
operator action on the cluster before it works:** a profile is a pod label,
and the agent-sandbox controller refuses a claim whose label key is outside
the `allowed-label-domains` key of the `agent-sandbox-config` ConfigMap in
the controller's own namespace (built-in default `sandbox.users.io`), while
this backend's default key is `sandbox.namzu.ai/egress-profile`. Add the
domain there, or set `egress.profileLabelKey` to a key already allowed.
Everything is additive: with no `egress.profile` set, every emitted body,
selector, policy name and request is byte for byte what it was.

Egress was one policy per backend: the translated policy's selector is the
template label alone, and a per-`create()` override is refused. Every network
mode therefore needed its own `SandboxTemplate`, its own `SandboxWarmPool`
and its own policy, and every warm replica is a full pod reservation
multiplied by the number of modes.

`KubernetesEgressConfig` gains two fields:

- `profile?: string` — a DNS-1123 label value, e.g. `none` or `internet`.
  Set, it is written onto the `SandboxClaim`'s
  `spec.additionalPodMetadata.labels`, onto a directly created `Sandbox`'s
  (and a workspace's) pod template, and into the translated policy's
  `podSelector`/`endpointSelector`. The default policy name becomes
  `${sandboxTemplateName}-${profile}-egress`.
- `profileLabelKey?: string` — the key it is written under. Defaults to
  `DEFAULT_EGRESS_PROFILE_LABEL_KEY` (`sandbox.namzu.ai/egress-profile`),
  now exported.

One thing to plan for when adopting it: **each profile needs its own applied
policy object.** A deployment that sets `profile` while leaving the policy an
operator applied selecting the template label alone gets
`KubernetesEgressPolicyMismatchError` on the first `create()` — by design,
because the selector is part of the exact-match verification, and a profile
whose policy does not select it would bound nothing.

Two new refusals are thrown, each catchable by class:
`KubernetesEgressProfileConfigError` (synchronous, while the host is being
wired, for a profile or key this backend will not emit — including
`sandbox.namzu.ai/template`, which would overwrite the template label, and a
`${template}-${profile}-egress` past the 253-character object-name limit) and
`KubernetesPodLabelNotObservedError` (the bound pod never carried the label;
the claim is released rather than a sandbox handed back, because an
unlabelled pod would run under whatever policy does select it).

**A claim the controller refuses for its metadata does NOT get a taxonomy of
its own.** `InvalidMetadata` is already one of the terminal claim reasons an
acquire fails fast on, so it still rejects with `KubernetesAcquireError`
(`reason: 'claim-rejected'`, `retryable: false`) whether or not a profile is
configured — an existing `catch` keeps working unchanged. The new
`KubernetesPodLabelsRejectedError` is exported but never thrown on its own: it
rides as that error's `cause`, carrying the pod labels this backend sent
(`requestedPodLabels`) and the `egress.profileLabelKey` that moves the
offending key to an allowed domain, neither of which the controller's own
message can know.

A third refusal is an existing class gaining a value: a workspace whose
standing `Sandbox` does not carry the configured profile on its pod template
is **not adopted**. `KubernetesWorkspaceMismatchError.field` gains
`'egressProfile'` beside `'sandboxTemplateName'` and `'runtimeClassName'`
(additive — a host matching on the two existing values is unaffected), and
the refusal lands before any resume patch, so the workspace is left asleep
rather than woken up to be rejected. The way to move an existing workspace
onto a profile is `refreshPodTemplate: true` on `resume()` or
`createKubernetesWorkspace`, which rewrites `spec.podTemplate` — profile label
included — on the one Suspended → Running transition; the refusal is lifted
for a call that is about to write the configured profile, exactly as the
`runtimeClassName` refusal is, and re-applied if the patch does not land. A
workspace that is neither refreshed nor recreated refuses to open rather than
opening under whatever policy still selects it.

Measured against agent-sandbox v1.0.2 on Kubernetes v1.37: six claims out of
one two-replica pool, alternating two profile values, each bound a replica
that already existed, in 47–61 ms, with the controller patching the label
onto the running pod and into the `Sandbox`'s own `spec.podTemplate`. What
was NOT measured anywhere in this repo is the egress difference between two
profiles — that is enforcement, and it needs a cluster that enforces.
