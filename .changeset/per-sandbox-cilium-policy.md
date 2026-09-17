---
'@namzu/sandbox': minor
---

`Sandbox.setNetworkPolicy` is now implemented on Kubernetes sandboxes — but
only on a TASK handle, only when the backend is configured with
`egress.perSandbox`, and only on a cluster where **both operator
prerequisites** are in place: the applied
`ValidatingAdmissionPolicy` and its binding
(`packages/sandbox/k8s/manifests/validatingadmissionpolicy-cilium.yaml`),
which the backend proves before its first write, and the opt-in RBAC file
(`rbac-per-sandbox-egress.yaml`), whose policy-write verbs the default
`rbac.yaml` Role deliberately still withholds. A host enabling the option
without the fence gets `KubernetesAdmissionFenceMissingError` and nothing is
written; without the RBAC it gets a `403` naming the verb. Everything is
additive: with no `egress.perSandbox`, the method is absent exactly as before
and no new request is issued on any path.

A `KubernetesWorkspace` handle never carries the method — nothing in its
create path composes a per-sandbox pod label or tracks an owner uid for one —
so `createKubernetesWorkspace` **refuses** a config carrying
`egress.perSandbox`, with `KubernetesWorkspacePerSandboxEgressConfigError`
and no request sent, rather than accepting a capability it would never serve.
A host that creates workspaces and task sandboxes from one config object
passes that call a config without `perSandbox`; task sandboxes are unaffected.

Live per-sandbox egress is the SDK's contract for "fetch the repository with
a token, then narrow before running what the repository contains", and the
Kubernetes backend omitted it: egress was one policy for every sandbox the
backend produced, so a per-tenant host list meant an operator-applied policy,
its own template and its own warm pool, per list.

Configured, each `setNetworkPolicy({ allowedHosts })` writes one
`CiliumNetworkPolicy` for that sandbox alone: named `namzu-sbx-<uid>` after
the `SandboxClaim` (or `Sandbox`) this backend created, selecting one
per-sandbox pod label carried in the same claim-time
`additionalPodMetadata.labels` map the egress profile travels in and confirmed
on the bound pod before the sandbox is handed back, owned by that object
through `ownerReferences` so `destroy()` lets the cluster collect it, and
allowing the cluster-DNS rule plus one `toFQDNs` rule for the list —
`api.example.com` for a host, `matchName` plus `matchPattern: '*.example.com'`
for a `.example.com` entry, carrying the same port/DNS-name/TLS-server-name
narrowing options the config-level allowlist has. `dnsNames` narrowing goes
one step further here than at the config level, because this translation is
the one that expands the domain form: an expanded entry also gets a
`matchPattern: '*.<host>.<suffix>'` for every cluster search suffix, since a
guest resolving `a.example.com` tries those suffixes first under the default
`ndots: 5` and a lookup the DNS proxy refuses can fail the whole resolution.
Both halves of that are new — the exact-host branch emits `<host>.<suffix>`
`matchName`s and never a pattern — and it is reachable only under
`perSandbox.narrowing`, where the entry really does admit subdomains. The call
resolves only after a read-back deep-equals what it sent, through the
comparator the named-object check already used. `setNetworkPolicy([])` deletes
that one object, leaving the configured baseline in force rather than no
policy at all.

Policies UNION, so a per-sandbox list ADDS to whatever `egress.policy`
translated to and only narrows when that baseline denies: pair `perSandbox`
with `no-network` or `deny-all` if `setNetworkPolicy` is to be the boundary
rather than an addition to one. Allowlist entries are hostnames, and letter
case is canonicalised rather than refused; a URL, a port suffix, an explicit
glob, an IP address and a whole public suffix such as `.com` are each refused
by name before anything is sent, the last two more strictly than the docker
backend's proxy.

One message correction rides along: `KubernetesEgressPolicyConfigError` now
spells its `field` relative to `config.egress` rather than to
`config.egress.policy`, because the fields that reach it live at both levels
— `policy.exceptCidrs` on the policy, `ciliumNarrowing` and
`perSandbox.narrowing` beside it — and the old prefix named a key that does
not exist for two of the three. A caller matching that error's `field` on the
literal `'exceptCidrs'` should match `'policy.exceptCidrs'` instead; nothing
about which values are refused has changed.

One combination is refused rather than translated: **a `.domain` allowlist
entry together with `tlsServerNames`**, with `KubernetesNetworkPolicyHostError`
and nothing written. A TLS server name is one exact SNI value a handshake
presents, while `.example.com` means that domain and every subdomain of it, so
`serverNames: ['.example.com']` is a value no handshake ever presents and
`['example.com']` would deny every subdomain the same rule's `toFQDNs` half
admits — the object is admitted by the fence and reads back deep-equal to what
was sent, so the call would report success and deny the domain it was asked to
allow. Refused at the translation, which covers `config.egress.ciliumNarrowing`
on the config-level allowlist as well as `perSandbox.narrowing`, and again —
earlier, before the fence is read — by the per-sandbox writer.

**The refusal's message is path-aware**, because the entry is a different
thing on each path and one sentence cannot be true of both. The per-sandbox
translation expands `.example.com` into a name plus a `*.example.com` pattern,
so its message says exactly that, and the remedy it offers — "list the exact
hosts, or leave `tlsServerNames` off for a domain list" — is a real repair
there. The CONFIG-level translation expands nothing: the entry reaches the
object as the literal `matchName: '.example.com'`, which no DNS answer carries,
so it admits nothing with the option on or off, and `serverNames` on top of it
is a second, independent denial. Its message says that instead of offering a
remedy that is not one. Which values are refused is unchanged; only what a
refused caller is told to do about it is. Each message names the caller's OWN
field — `config.egress.perSandbox.narrowing` for the expanding one,
`config.egress.ciliumNarrowing` for the config-level one — and the
config-level one omits the closing sentence saying what an entry means, since
that is the grammar its translation does not apply. (That a config-level
`.domain` entry matches no answer at all is a pre-existing defect of this
shipped translation: it is left exactly as it was and deferred to its own
change.)

A fence read the API server REFUSES (a `401`/`403` — most often the namespaced
`Role` applied without the `ClusterRole` in the same file, since both admission
objects are cluster-scoped) is now its own refusal,
`KubernetesAdmissionFenceUnreadableError`, rather than being reported as a
missing fence: `404` means the object is not there, `403` means this host may
not look, and the two send an operator to different files. Nothing is written
in either case.

New exports: `KubernetesAdmissionFenceUnreadableError`,
`KubernetesPerSandboxEgressConfig`,
`KubernetesPerSandboxEgressConfigError`, `KubernetesAdmissionFenceMissingError`,
`KubernetesNetworkPolicyHostError`, `KubernetesOwnerUidMissingError`,
`KubernetesWorkspacePerSandboxEgressConfigError`,
`DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY`,
`PER_SANDBOX_POLICY_NAME_PREFIX`. `egress.perSandbox.engine: 'core'` is
refused synchronously while the host is being wired, because core
`NetworkPolicy` has no hostname concept to translate an allowlist into. The
per-sandbox selector key defaults to `sandbox.namzu.ai/per-sandbox-egress`,
which carries the same controller `allowed-label-domains` prerequisite the
egress profile's key does, and the shipped admission policy pins that KEY
alongside the owner's name as the value — the value check alone would let a
claim named `namzu-task` select on the shared template label.

**Enforcement was not measured in this repository.** What was measured, on a
local single-node cluster running the upstream `CiliumNetworkPolicy` CRD with
no data plane at all: that the exact body written is admitted by the shipped
fence and its replacement merge-patch is too; that the fence refuses a name
without the prefix, a name whose suffix is not its owner's uid, a missing or
foreign owner, `blockOwnerDeletion: true`, a two-label selector, a one-label
selector pointed at any pod but the owner's own, a `toFQDNs` entry matching
every name (`'*'`, `'*.*'`, `'*.com'`), the kube-dns rule moved off port 53,
`toEntities`, `toCIDR`, an ingress rule, a `specs` list, a widening patch and
a `DELETE` of the operator's own policy; that 51 concurrent claims produced 51
distinct policies with no cross-writes; and that deleting a claim collected
exactly its policy (about 100 ms) while the operator's unowned policy
survived. That an allowed host answers and a disallowed one does not is a
property of a CNI data plane and needs a real Cilium cluster with a positive
control.
