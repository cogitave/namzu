---
"@namzu/sandbox": patch
---

A kubernetes deployment with `egress.policy: { kind: 'no-network' }` can create
sandboxes again. It could not before: every `create()` was refused with
`KubernetesEgressPolicyMismatchError` — a host that maps that to a reason such
as `sandbox-egress-policy-unverified` fails the run closed — and no policy an
operator could apply would have cleared it.

The named-object check compared `spec.egress` to the translation with a
deep-equal, and a core `NetworkPolicy` never stores an empty rule list:
`egress` is `omitempty` on the wire struct, so an object applied with
`egress: []` reads back with no `egress` key at all, and a merge patch cannot
put one back.
`no-network`'s whole translation IS that empty list, so `undefined !== []` made
the check unsatisfiable by any object a cluster can store. `verifyEgressPolicyApplied`
now reads an absent `egress` as the empty list it is, in that one comparison.
They are one policy and not merely one shape, because the check has already
required `policyTypes` to include `'Egress'` on a core policy, and that alone
denies all egress.

Nothing else is loosened. A live object whose rule array is non-empty still
fails a translation that intended none, and a live object with no `egress` at
all still fails a translation that intended rules — an absent list means
deny-all, which is not what config asked for. The comparison still exists to
refuse an object enforcing anything other than what was intended.

`patch`, and the reason it is not a `major`: this is not a change to the public
surface. No export, field, option or default moved, and the accepted set grows
by exactly the object the API server stores for the intent the deployment had
already declared. The refusal that disappears is one no consumer could have
been relying on — `no-network` is configured in order to create sandboxes, and
the only thing the refusal ever did was prevent that — so no upgrade action is
required and no deployment that passes today starts failing.

There was also no setting that avoided the refusal, so nothing to unset:
`egress.verify: 'named-object-only'` opts out of the UNION check and nothing
else — `egressUnionVerificationEnabled` gates `verifyUnion`, while the
named-object check runs on every create path regardless — so a `no-network`
host was refused under either setting. The ways out were to configure no
`egress` at all, or to fall back to `deny-all`, which allows the cluster
resolver on port 53 and is therefore not the same boundary.

Verified against a live `kind` cluster (v1.37), not only against a fake API
server: the `no-network` manifest applied, the object read back with this
backend's own client (a core `NetworkPolicy` stored with no `egress` key, and
`kubectl patch --type=merge -p '{"spec":{"egress":[]}}'` does not restore one),
and the real `verifyEgressPolicyApplied` run on what came off the cluster —
refused before this change, verified after, with a live object carrying a rule
and a live object carrying none both still refused.
