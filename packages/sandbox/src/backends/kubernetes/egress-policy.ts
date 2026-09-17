/**
 * Egress policy translation for the Kubernetes backend, and the
 * verify-not-trust check that stops a misconfigured cluster from silently
 * running unenforced.
 *
 * Mirrors two existing shapes rather than inventing a third:
 *
 *  - `../firecracker/index.ts`'s `resolveNetworkPolicy` — a pure(ish) mapping
 *    from the shared {@link EgressPolicy} union to what one specific
 *    enforcement point can actually carry, with an exhaustive switch that
 *    refuses an unknown kind instead of defaulting to open.
 *  - `../docker/index.ts`'s `assertNetworkCarriesThePolicy` — the refusal
 *    discipline. That function does not trust a docker network's NAME to
 *    mean "internal"; it inspects the daemon's own `{{.Internal}}` flag. The
 *    same principle drives {@link verifyEgressPolicyApplied} here: this
 *    backend does not trust that an operator applied the right
 *    `NetworkPolicy` because a name matches — it GETs the live object and
 *    compares its shape.
 *
 * ## What core `NetworkPolicy` can and cannot express
 *
 * Core Kubernetes `NetworkPolicy` has exactly three ways to name a
 * destination: `ipBlock` (CIDR), `podSelector` and `namespaceSelector`. There
 * is no hostname or FQDN concept anywhere in the resource. So of the four
 * {@link EgressPolicy} kinds:
 *
 *  - `deny-all` and `allow-all` are fully expressible — neither needs a
 *    hostname.
 *  - `static` and `resolver` are hostname allowlists and are NOT expressible
 *    under core `NetworkPolicy` at all. {@link assertEgressPolicyIsEnforceable}
 *    throws a named error for both, rather than silently downgrading to an
 *    `HTTP_PROXY`/`HTTPS_PROXY` environment variable the way the container
 *    tier's open allowlist gap does (`#398`) — a workload that ignores a
 *    proxy variable bypasses it entirely, and repeating that mistake behind a
 *    Kubernetes-shaped manifest would not fix it.
 *
 * `KubernetesEgressConfig.engine: 'cilium'` is the one escape hatch, and it
 * is opt-in: a cluster that actually runs Cilium can express a hostname
 * allowlist as a `CiliumNetworkPolicy` with `toFQDNs`, so declaring the
 * engine turns the refusal into an emission. No other engine is supported in
 * this batch — Calico's `HostEndpoint`/`GlobalNetworkPolicy` and any other
 * FQDN-capable CNI would need their own translation, added as their own
 * `engine` value with their own resource shape, not folded into this one by
 * guessing.
 *
 * ## Why a NetworkPolicy always allows the cluster's own DNS
 *
 * agent-sandbox's OWN managed `NetworkPolicy`
 * (`SandboxTemplateSpec.networkPolicy` /
 * `networkPolicyManagement: Managed`, the CRD's default) already leaves the
 * cluster's own name service reachable — the upstream reference deployment
 * (kubernetes-sigs/agent-sandbox `examples/kata-aks/sandboxtemplate.yaml`)
 * ships exactly "ingress from the router only, egress limited to DNS (53)
 * and TCP/443". {@link CLUSTER_DNS_EGRESS_RULE} matches that convention
 * (CoreDNS/kube-dns lives in the `kube-system` namespace on every cluster
 * this was checked against) rather than inventing a different one.
 *
 * This is not a case of one policy overriding another: the Kubernetes API
 * server UNIONS every `NetworkPolicy` selecting a pod — traffic is allowed if
 * ANY matching policy's rule allows it, never the intersection — so this
 * rule does not need to duplicate the managed policy to avoid "fighting" it
 * in the sense of narrowing anything. It exists so THIS backend's own
 * translated policy is self-sufficient: on a cluster where an operator left
 * `networkPolicyManagement: Unmanaged`, or copied the managed shape
 * imperfectly, `deny-all` still means "the cluster's own name service,
 * nothing else" instead of a pod that cannot even resolve
 * `kubernetes.default`.
 *
 * ## Never a proxy environment variable
 *
 * No code path in this module emits `HTTP_PROXY`, `HTTPS_PROXY` or any other
 * proxy variable, and none of the module's own string constants contain
 * those substrings either — a dedicated test scans both. Proxy variables are
 * advisory: a process that does not read them is not bounded by them. The
 * boundary here is the `NetworkPolicy` object itself, enforced by the CNI in
 * the kernel, not by the workload's cooperation.
 */

import { isDeepStrictEqual } from 'node:util'
import type { EgressPolicy } from '../../index.js'
// The policy-enumeration and shape-reading primitives, shared with the
// ingress direction. There is one enumeration of the policies selecting a pod
// in this package and one reading of what a peer is; see that module's
// "Shared with the egress direction".
import {
	type SelectorMatch,
	UnreadPolicyCollection,
	type UnreadPolicySource,
	ciliumIdentityLabels,
	ciliumSelectorKey,
	corePeerIsWideOpen,
	formatLabels,
	isRecord,
	listPolicies,
	matchesLabelSelector,
	policyName,
	readList,
	selectorIsReadable,
} from './ingress-policy.js'
import { KubernetesAlreadyGoneError, type KubernetesClient } from './k8s-client.js'
import {
	CILIUM_NETWORK_POLICY_API_GROUP,
	CILIUM_NETWORK_POLICY_API_VERSION,
	CORE_NETWORK_POLICY_API_GROUP,
	CORE_NETWORK_POLICY_API_VERSION,
	ciliumNetworkPolicyCollectionPath,
	ciliumNetworkPolicyPath,
	networkPolicyCollectionPath,
	networkPolicyPath,
	sandboxTemplateLabel,
} from './objects.js'

/**
 * `'core'` (the default) is plain Kubernetes `NetworkPolicy` — every cluster
 * has it, and it cannot express a hostname. `'cilium'` opts into emitting a
 * `CiliumNetworkPolicy` for a hostname allowlist, and is meaningless unless
 * the target cluster actually runs Cilium as its CNI.
 */
export type KubernetesEgressEngine = 'core' | 'cilium'

/**
 * The two egress kinds that exist only here, because only a `NetworkPolicy`
 * can express them and the shared {@link EgressPolicy} union describes what
 * every tier can carry.
 *
 *  - `'no-network'` is the one the shared union has no word for: NOTHING
 *    leaves the pod, the cluster's own resolver included. `'deny-all'` is not
 *    that and never was — it emits {@link CLUSTER_DNS_EGRESS_RULE}, and a
 *    cluster resolver forwards outside names upstream, so a `'deny-all'`
 *    sandbox keeps a channel out through DNS. `'deny-all'` is deliberately
 *    NOT tightened into this: its emitted manifest is byte-identical to
 *    every release before this one, because verification of the named object
 *    is an exact match and changing the translation would fail every
 *    `create()` on every deployment that already applied a policy until an
 *    operator re-applied it. A workload under `'no-network'` resolves
 *    nothing at all — that is the point, and the agent needs no resolver
 *    because the host dials in.
 *  - `'public-internet'` is `'allow-all'` minus everything that is not the
 *    public internet: the private ranges, the carrier-grade NAT range, the
 *    link-local range that carries cloud instance metadata, loopback, the
 *    platform endpoint some clouds answer on, and IPv6's equivalents. It
 *    exists because `'allow-all'` reaches the node, the API server, the
 *    service network and every other sandbox pod, and nothing between the
 *    two said "out, but not sideways".
 *
 * `exceptCidrs` adds to the excluded list; it never removes from it. A CIDR
 * that is not one this check can parse is refused at construction rather
 * than emitted into a manifest the API server would reject on apply.
 */
export type KubernetesOnlyEgressPolicy =
	| { readonly kind: 'no-network' }
	| {
			readonly kind: 'public-internet'
			readonly exceptCidrs?: readonly string[]
	  }

/**
 * What {@link KubernetesEgressConfig.policy} accepts: the shared
 * {@link EgressPolicy} union plus the two {@link KubernetesOnlyEgressPolicy}
 * kinds. The shared union itself is untouched — a kind no other tier can
 * enforce does not belong in the type every tier reads.
 */
export type KubernetesEgressPolicy = EgressPolicy | KubernetesOnlyEgressPolicy

/**
 * How thoroughly the applied boundary is checked before a sandbox is handed
 * back.
 *
 *  - `'union'` (the default) reads the NAMED object exactly as before AND
 *    enumerates every `NetworkPolicy` — and, under `engine: 'cilium'`, every
 *    `CiliumNetworkPolicy` — in the namespace, refusing when any policy that
 *    selects the pod allows egress the configured translation does not. That
 *    is not belt-and-braces: the API server UNIONS every policy selecting a
 *    pod, so a second policy widens egress however exactly the named one
 *    matches, and a `SandboxTemplate`'s own `networkPolicy` block becomes
 *    exactly such a policy.
 *  - `'named-object-only'` is the documented opt-out, and restores the
 *    previous behaviour exactly: one GET of the named object, memoized for
 *    the backend's lifetime, and no enumeration. For a deployment whose
 *    other policies a namespaced Role cannot read, or which accepts the
 *    union it has. It mirrors `ingress: 'unverified'` — a claim a deployment
 *    makes on purpose rather than a default it inherits.
 */
export type KubernetesEgressVerification = 'union' | 'named-object-only'

/**
 * The config-level egress hook on {@link KubernetesBackendConfig}.
 *
 * Deliberately CONFIG-level, not per-`create()`: the enforcement point is a
 * `NetworkPolicy` attached to the `SandboxTemplate` (or, for `static`, to a
 * dedicated `CiliumNetworkPolicy`), and neither can be rewritten per running
 * sandbox — the same reason `SandboxBackendOptions.egress` is refused by
 * `assertEnforceable` in `index.ts`. That refusal is unchanged by this file;
 * it covers a caller trying to override egress PER SANDBOX, while this is
 * the one egress policy the whole backend enforces.
 */
export interface KubernetesEgressConfig {
	readonly policy: KubernetesEgressPolicy
	/**
	 * Name of the `NetworkPolicy` (or `CiliumNetworkPolicy`, under the
	 * `'cilium'` engine) an operator applied. Defaults to
	 * {@link defaultEgressPolicyName}'s output for the configured
	 * `sandboxTemplateName`.
	 */
	readonly networkPolicyName?: string
	/** Default `'core'`. See the type doc. */
	readonly engine?: KubernetesEgressEngine
	/** Default `'union'`. See {@link KubernetesEgressVerification}. */
	readonly verify?: KubernetesEgressVerification
}

/** `true` unless the deployment asked for the single-object check by name. */
export function egressUnionVerificationEnabled(
	egress: KubernetesEgressConfig | undefined,
): boolean {
	return egress !== undefined && egress.verify !== 'named-object-only'
}

/** Where a translated policy is targeted, and what its `podSelector` names. */
export interface EgressPolicyTarget {
	readonly namespace: string
	readonly name: string
	/**
	 * The label VALUE the translated policy's `podSelector` /
	 * `endpointSelector` matches — see {@link sandboxTemplateLabel} for the
	 * key and why every Sandbox this backend produces, pooled or direct,
	 * carries it.
	 */
	readonly sandboxTemplateName: string
}

/**
 * A translated policy: which kind of Kubernetes object it is, where it
 * lives, and the manifest an operator applies verbatim. `kind` is the
 * ENFORCEMENT RESOURCE this translation actually produced — for `deny-all`
 * and `allow-all` that is always `'NetworkPolicy'`, even when
 * `KubernetesEgressConfig.engine` is `'cilium'`, because core
 * `NetworkPolicy` already expresses both fully and Cilium enforces plain
 * `NetworkPolicy` objects too. `engine` only changes the outcome for a
 * hostname allowlist, which needs Cilium's CRD to exist at all.
 */
export interface KubernetesTranslatedEgressPolicy {
	readonly kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
	/**
	 * The CONFIGURED kind this came from, carried so a refusal can name what
	 * the deployment asked for (`no-network`, `public-internet`, …) rather
	 * than only the resource it produced.
	 */
	readonly policyKind: KubernetesEgressPolicy['kind']
	readonly namespace: string
	readonly name: string
	readonly manifest: Readonly<Record<string, unknown>>
}

/** `${sandboxTemplateName}-egress`, the name {@link KubernetesEgressConfig.networkPolicyName} defaults to. */
export function defaultEgressPolicyName(sandboxTemplateName: string): string {
	return `${sandboxTemplateName}-egress`
}

/**
 * Named refusal for a hostname allowlist with no FQDN-capable engine
 * declared. Thrown SYNCHRONOUSLY from `buildKubernetesBackend` — see
 * {@link assertEgressPolicyIsEnforceable} — so a misconfiguration surfaces
 * during host wiring, the same moment `assertRuntimeClassIsApplicable` and
 * the readiness-bounds validation do, rather than on the first `create()`.
 */
export class KubernetesUnenforceableEgressPolicyError extends Error {
	override readonly name = 'KubernetesUnenforceableEgressPolicyError'

	constructor(readonly policyKind: 'static' | 'resolver') {
		super(
			`The kubernetes sandbox backend cannot enforce an egress policy of kind '${policyKind}' as a NetworkPolicy: core Kubernetes NetworkPolicy has only ipBlock, podSelector and namespaceSelector — it has no hostname/FQDN concept at all. This cluster needs an FQDN-capable policy engine: set config.egress.engine to 'cilium' if the target cluster actually runs it (see docs/sdk/kubernetes-sandbox.md's egress section), or configure an egress policy of 'deny-all' or 'allow-all' instead. Refusing rather than silently downgrading to an HTTP_PROXY/HTTPS_PROXY environment variable an uncooperative process can ignore.`,
		)
	}
}

/**
 * Named refusal for a config value this backend can read but not use — today
 * only a `public-internet` `exceptCidrs` entry that is not a CIDR. Thrown
 * SYNCHRONOUSLY from `buildKubernetesBackend`, beside
 * {@link KubernetesUnenforceableEgressPolicyError}, so a typo surfaces
 * during host wiring rather than as a policy the API server rejects when an
 * operator applies it.
 */
export class KubernetesEgressPolicyConfigError extends Error {
	override readonly name = 'KubernetesEgressPolicyConfigError'

	constructor(
		readonly field: string,
		reason: string,
	) {
		super(`kubernetes: config.egress.policy.${field} is unusable: ${reason}`)
	}
}

/**
 * Synchronous, no-I/O precondition: can `policy.kind` be enforced under
 * `engine` at all. Deliberately decided from the KIND alone — a `resolver`
 * policy's `resolve()` is never invoked here, both because calling it just to
 * prove a refusal would be wasted work (and possibly a side effect the host
 * did not expect yet) and because this has to stay callable synchronously
 * from `buildKubernetesBackend`, which contacts nothing.
 */
export function assertEgressPolicyIsEnforceable(
	policy: KubernetesEgressPolicy,
	engine: KubernetesEgressEngine,
): void {
	if ((policy.kind === 'static' || policy.kind === 'resolver') && engine !== 'cilium') {
		throw new KubernetesUnenforceableEgressPolicyError(policy.kind)
	}
	if (policy.kind === 'public-internet') {
		for (const cidr of policy.exceptCidrs ?? []) {
			if (parseCidr(cidr) === undefined) {
				throw new KubernetesEgressPolicyConfigError(
					'exceptCidrs',
					`${JSON.stringify(cidr)} is not an IPv4 or IPv6 CIDR this backend can read. A NetworkPolicy ipBlock.except entry has to be a CIDR inside the block it carves out of, and an entry the API server rejects on apply would leave a policy that never verifies.`,
				)
			}
		}
	}
}

/**
 * The cluster DNS egress rule every translated `NetworkPolicy` carries,
 * including on `deny-all`. See the module doc's "Why a NetworkPolicy always
 * allows the cluster's own DNS" section.
 */
const CLUSTER_DNS_EGRESS_RULE = {
	to: [
		{
			namespaceSelector: {
				matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
			},
		},
	],
	ports: [
		{ protocol: 'UDP', port: 53 },
		{ protocol: 'TCP', port: 53 },
	],
} as const

/**
 * DNS to the cluster resolver's own pods, which is narrower than
 * {@link CLUSTER_DNS_EGRESS_RULE}'s whole-namespace rule and is what
 * `'public-internet'` emits: that kind exists to name a destination set
 * precisely, so it names the resolver precisely too. `kube-system` +
 * `k8s-app: kube-dns` is the pairing CoreDNS ships under on every cluster
 * this was checked against, and the same pairing the repo's own
 * `k8s/manifests/networkpolicy.yaml` baseline already uses.
 *
 * `'deny-all'` keeps {@link CLUSTER_DNS_EGRESS_RULE} instead. It is not
 * changed to this one: its emitted manifest is pinned byte-for-byte, because
 * verification of the named object is an exact match and any change to the
 * translation fails every `create()` on every deployment that already
 * applied a policy.
 */
const KUBE_DNS_EGRESS_RULE = {
	to: [
		{
			namespaceSelector: {
				matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
			},
			podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
		},
	],
	ports: [
		{ protocol: 'UDP', port: 53 },
		{ protocol: 'TCP', port: 53 },
	],
} as const

/**
 * What `'public-internet'` carves out of `0.0.0.0/0`, and why each entry is
 * here. Order is part of the emitted manifest and therefore part of what
 * verification compares, so it is fixed rather than sorted at build time.
 *
 *  - `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — RFC 1918. The cluster
 *    network, the node network and every other sandbox pod live in one of
 *    them on every deployment this was checked against.
 *  - `100.64.0.0/10` — RFC 6598 carrier-grade NAT, which several managed
 *    Kubernetes offerings hand to pods or nodes. Missing from the policy the
 *    agent-sandbox controller writes when a template declares no
 *    `networkPolicy`, which is exactly why this check compares except lists
 *    rather than trusting that a policy "looks restrictive".
 *  - `169.254.0.0/16` — link-local, and with it `169.254.169.254`, the
 *    instance-metadata address whose credentials are the reason a sandbox
 *    reaching "only the internet" still must not reach sideways.
 *  - `127.0.0.0/8` — loopback. Not routable off the pod, but a policy that
 *    says "the public internet" should not say it admits loopback either.
 *  - `168.63.129.16/32` — one cloud's platform endpoint, a single address
 *    outside every range above that answers DNS and instance services.
 */
const PUBLIC_INTERNET_EXCLUDED_IPV4_CIDRS = [
	'10.0.0.0/8',
	'172.16.0.0/12',
	'192.168.0.0/16',
	'100.64.0.0/10',
	'169.254.0.0/16',
	'127.0.0.0/8',
	'168.63.129.16/32',
] as const

/**
 * The IPv6 equivalents: unique-local (`fc00::/7`), link-local
 * (`fe80::/10`, which carries the v6 spelling of instance metadata) and
 * loopback (`::1/128`). A cluster with no IPv6 at all is unaffected by the
 * rule's presence — it names destinations nothing routes to.
 */
const PUBLIC_INTERNET_EXCLUDED_IPV6_CIDRS = ['fc00::/7', 'fe80::/10', '::1/128'] as const

/**
 * The one rule `'public-internet'` adds beside DNS: everything, minus the
 * lists above, minus whatever the deployment added. No `ports`, because the
 * kind is a statement about DESTINATIONS — a deployment that also wants to
 * bound ports states that in its own applied policy, which this check then
 * accepts as narrower.
 *
 * A deployment's own `exceptCidrs` are routed to the block of their own
 * address family: a `NetworkPolicy` requires every `except` entry to sit
 * inside the `cidr` it carves out of, so an IPv6 entry under the IPv4 block
 * is rejected on apply.
 */
function publicInternetEgressRule(
	exceptCidrs: readonly string[] | undefined,
): Readonly<Record<string, unknown>> {
	const extraV4: string[] = []
	const extraV6: string[] = []
	for (const cidr of exceptCidrs ?? []) {
		const parsed = parseCidr(cidr)
		// Unparseable entries are refused by `assertEgressPolicyIsEnforceable`
		// at construction; reaching here with one would mean this function was
		// called around it, so it is dropped rather than emitted.
		if (parsed === undefined) continue
		;(parsed.version === 4 ? extraV4 : extraV6).push(cidr)
	}
	return {
		to: [
			{
				ipBlock: {
					cidr: '0.0.0.0/0',
					except: [...PUBLIC_INTERNET_EXCLUDED_IPV4_CIDRS, ...extraV4],
				},
			},
			{
				ipBlock: {
					cidr: '::/0',
					except: [...PUBLIC_INTERNET_EXCLUDED_IPV6_CIDRS, ...extraV6],
				},
			},
		],
	}
}

/**
 * Cilium requires DNS lookups to be explicitly allowed AND made visible to
 * the agent before `toFQDNs` enforcement can match anything a name resolves
 * to: without a preceding rule granting DNS and turning on visibility, the
 * sandbox's own lookups for the allowed hosts are invisible to Cilium's
 * FQDN-to-IP mapping and `toFQDNs` matches nothing, which would make a
 * `static`/`resolver` policy fail closed for every host rather than only the
 * disallowed ones.
 *
 * Shape verified against Cilium's own worked example — the `toFQDNs`
 * `CiliumNetworkPolicy` at https://docs.cilium.io/en/stable/security/dns/
 * (the "DNS Based" policy walkthrough) allows egress to `kube-dns` on port 53
 * with `rules.dns: [{ matchPattern: "*" }]` alongside its own `toFQDNs` rule
 * — this constant reproduces that DNS-allow rule verbatim, including the
 * `k8s:` label-source prefix on both `toEndpoints` selector keys (an
 * unprefixed key defaults to label source `any`, a superset that would still
 * match, but `any` is not what the cited example uses).
 */
const CILIUM_DNS_VISIBILITY_RULE = {
	toEndpoints: [
		{
			matchLabels: {
				'k8s:io.kubernetes.pod.namespace': 'kube-system',
				'k8s:k8s-app': 'kube-dns',
			},
		},
	],
	toPorts: [
		{
			ports: [{ port: '53', protocol: 'ANY' }],
			rules: { dns: [{ matchPattern: '*' }] },
		},
	],
} as const

function buildCoreNetworkPolicy(
	target: EgressPolicyTarget,
	policyKind: KubernetesEgressPolicy['kind'],
	egress: readonly Readonly<Record<string, unknown>>[],
): KubernetesTranslatedEgressPolicy {
	return {
		kind: 'NetworkPolicy',
		policyKind,
		namespace: target.namespace,
		name: target.name,
		manifest: {
			apiVersion: `${CORE_NETWORK_POLICY_API_GROUP}/${CORE_NETWORK_POLICY_API_VERSION}`,
			kind: 'NetworkPolicy',
			metadata: { name: target.name, namespace: target.namespace },
			spec: {
				podSelector: {
					matchLabels: sandboxTemplateLabel(target.sandboxTemplateName),
				},
				policyTypes: ['Egress'],
				egress,
			},
		},
	}
}

function buildCiliumNetworkPolicy(
	target: EgressPolicyTarget,
	policyKind: KubernetesEgressPolicy['kind'],
	allowedHosts: readonly string[],
): KubernetesTranslatedEgressPolicy {
	return {
		kind: 'CiliumNetworkPolicy',
		policyKind,
		namespace: target.namespace,
		name: target.name,
		manifest: {
			apiVersion: `${CILIUM_NETWORK_POLICY_API_GROUP}/${CILIUM_NETWORK_POLICY_API_VERSION}`,
			kind: 'CiliumNetworkPolicy',
			metadata: { name: target.name, namespace: target.namespace },
			spec: {
				endpointSelector: {
					matchLabels: sandboxTemplateLabel(target.sandboxTemplateName),
				},
				egress: [
					CILIUM_DNS_VISIBILITY_RULE,
					{ toFQDNs: allowedHosts.map((host) => ({ matchName: host })) },
				],
			},
		},
	}
}

/**
 * The pure translation: an {@link EgressPolicy} plus the declared
 * {@link KubernetesEgressEngine} in, the concrete manifest this backend can
 * ask an operator to apply out. Async only because `resolver` carries an
 * async `resolve()` — `deny-all`, `allow-all` and `static` never await
 * anything.
 *
 * `resolver` is resolved ONCE here (at whatever call site first needs the
 * manifest — `buildKubernetesBackend`'s first `create()`, in practice), not
 * once per `create()` the way the docker and Firecracker backends re-resolve
 * a PER-SANDBOX `resolver` policy on every call. That is a deliberate
 * difference, not a shortcut: the enforcement point here is one
 * `NetworkPolicy`/`CiliumNetworkPolicy` object shared by every sandbox this
 * backend produces, so there is exactly one manifest to compare the resolved
 * hosts against, and re-resolving on every `create()` would only produce a
 * value nothing downstream re-applies to the cluster.
 */
export async function translateEgressPolicy(
	policy: KubernetesEgressPolicy,
	engine: KubernetesEgressEngine,
	target: EgressPolicyTarget,
): Promise<KubernetesTranslatedEgressPolicy> {
	assertEgressPolicyIsEnforceable(policy, engine)

	switch (policy.kind) {
		case 'deny-all':
			return buildCoreNetworkPolicy(target, 'deny-all', [CLUSTER_DNS_EGRESS_RULE])
		case 'no-network':
			// `policyTypes: ['Egress']` with an EMPTY rule list is the API's own
			// spelling of "this pod sends nothing": the pod is in egress
			// default-deny and no rule lets anything back out. Not even DNS —
			// see the kind's own doc.
			return buildCoreNetworkPolicy(target, 'no-network', [])
		case 'public-internet':
			return buildCoreNetworkPolicy(target, 'public-internet', [
				KUBE_DNS_EGRESS_RULE,
				publicInternetEgressRule(policy.exceptCidrs),
			])
		case 'allow-all':
			// No `to`/`ports` on an egress rule matches every destination and
			// every port. `CLUSTER_DNS_EGRESS_RULE` is a strict subset of this,
			// so it is folded in rather than listed twice.
			return buildCoreNetworkPolicy(target, 'allow-all', [{}])
		case 'static':
			// `assertEgressPolicyIsEnforceable` already threw above unless
			// `engine === 'cilium'`, so reaching here means it did not.
			return buildCiliumNetworkPolicy(target, 'static', policy.allowedHosts)
		case 'resolver': {
			const allowedHosts = await policy.resolve()
			return buildCiliumNetworkPolicy(target, 'resolver', allowedHosts)
		}
		default: {
			const exhaustive: never = policy
			throw new Error(
				`kubernetes: unhandled egress policy kind ${JSON.stringify(exhaustive)}. Refusing rather than defaulting to unrestricted network access.`,
			)
		}
	}
}

/**
 * Raised by {@link verifyEgressPolicyApplied} when the named object does not
 * exist at all. This backend never CREATES the policy itself — like the
 * docker backend's network, the boundary is operator-applied so it gets
 * reviewed outside the hot create path, by whoever has cluster-admin rather
 * than by whatever created the ServiceAccount token this backend runs with.
 */
export class KubernetesEgressPolicyNotAppliedError extends Error {
	override readonly name = 'KubernetesEgressPolicyNotAppliedError'

	constructor(
		readonly resourceKind: 'NetworkPolicy' | 'CiliumNetworkPolicy',
		readonly path: string,
	) {
		super(
			`kubernetes: config.egress is set but no ${resourceKind} exists at ${path}. This backend never creates the egress policy itself — apply the manifest it computed (see docs/sdk/kubernetes-sandbox.md's egress section) before creating a sandbox with an egress policy configured. Refusing rather than creating a sandbox with no enforced network boundary.`,
		)
	}
}

/** Raised when the applied object exists but does not match the translation. */
export class KubernetesEgressPolicyMismatchError extends Error {
	override readonly name = 'KubernetesEgressPolicyMismatchError'

	constructor(
		readonly resourceKind: 'NetworkPolicy' | 'CiliumNetworkPolicy',
		readonly path: string,
		readonly reason: string,
	) {
		super(
			`kubernetes: the ${resourceKind} at ${path} does not match the egress policy config.egress computed: ${reason}. Re-apply the manifest this backend translated rather than hand-editing the cluster object — a policy that has drifted from config silently changes what a sandbox can reach without config saying so.`,
		)
	}
}

/**
 * Verify-not-trust: GET the object {@link translateEgressPolicy} named and
 * assert its shape actually matches, rather than trusting that an object
 * with the right name does what config says. Mirrors
 * `../docker/index.ts`'s `assertNetworkCarriesThePolicy`, which inspects the
 * daemon's own `{{.Internal}}` flag instead of trusting a network's name.
 *
 * Checks exactly three things, each named separately in a mismatch so an
 * operator sees which one to fix:
 *  - the selector (`podSelector` for `NetworkPolicy`, `endpointSelector` for
 *    `CiliumNetworkPolicy`) carries the expected template label:
 *  - `NetworkPolicy` additionally declares `policyTypes` including
 *    `'Egress'` — a `NetworkPolicy` with an `egress` array but no `'Egress'`
 *    in `policyTypes` enforces nothing on egress at all;
 *  - the `egress` rule array matches the translation exactly.
 *
 * Never mutates and never creates — a 404/410 is refused, not repaired.
 */
export async function verifyEgressPolicyApplied(
	client: KubernetesClient,
	translated: KubernetesTranslatedEgressPolicy,
	signal?: AbortSignal,
): Promise<void> {
	const path =
		translated.kind === 'CiliumNetworkPolicy'
			? ciliumNetworkPolicyPath(translated.namespace, translated.name)
			: networkPolicyPath(translated.namespace, translated.name)

	let resource: { readonly spec?: Readonly<Record<string, unknown>> } | undefined
	try {
		resource = await client.request('GET', path, undefined, signal)
	} catch (err) {
		if (err instanceof KubernetesAlreadyGoneError) {
			throw new KubernetesEgressPolicyNotAppliedError(translated.kind, path)
		}
		throw err
	}

	const expectedSpec = (translated.manifest as { readonly spec: Record<string, unknown> }).spec
	const actualSpec = resource?.spec ?? {}
	const selectorKey = translated.kind === 'CiliumNetworkPolicy' ? 'endpointSelector' : 'podSelector'

	if (!isDeepStrictEqual(actualSpec[selectorKey], expectedSpec[selectorKey])) {
		throw new KubernetesEgressPolicyMismatchError(
			translated.kind,
			path,
			`spec.${selectorKey} is ${JSON.stringify(actualSpec[selectorKey])}, expected ${JSON.stringify(expectedSpec[selectorKey])} — the label every Sandbox this backend creates carries`,
		)
	}

	if (translated.kind === 'NetworkPolicy') {
		const policyTypes = actualSpec.policyTypes
		if (!Array.isArray(policyTypes) || !policyTypes.includes('Egress')) {
			throw new KubernetesEgressPolicyMismatchError(
				translated.kind,
				path,
				`spec.policyTypes is ${JSON.stringify(policyTypes)}, expected an array containing 'Egress' — without it, spec.egress enforces nothing`,
			)
		}
	}

	if (!isDeepStrictEqual(actualSpec.egress, expectedSpec.egress)) {
		throw new KubernetesEgressPolicyMismatchError(
			translated.kind,
			path,
			`spec.egress is ${JSON.stringify(actualSpec.egress)}, expected ${JSON.stringify(expectedSpec.egress)}`,
		)
	}
}

// ---------------------------------------------------------------------------
// CIDR arithmetic
// ---------------------------------------------------------------------------
//
// Enough of it to answer one question: is this policy's block inside the
// block the translation allows. Written here rather than taken from a
// dependency because `packages/sandbox` declares no runtime dependency and
// this is forty lines of integer arithmetic.

/** A CIDR as a masked base address and a prefix length. */
export interface ParsedCidr {
	readonly version: 4 | 6
	readonly base: bigint
	readonly bits: number
}

function parseIpv4(text: string): bigint | undefined {
	const parts = text.split('.')
	if (parts.length !== 4) return undefined
	let value = 0n
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined
		const octet = Number(part)
		if (octet > 255) return undefined
		value = (value << 8n) | BigInt(octet)
	}
	return value
}

function parseIpv6(text: string): bigint | undefined {
	// An embedded IPv4 tail (`::ffff:10.0.0.1`) is legal and is how a
	// dual-stack cluster spells a v4 address in a v6 field.
	let head = text
	let tail = 0n
	let tailGroups = 0
	const lastColon = text.lastIndexOf(':')
	if (lastColon >= 0 && text.slice(lastColon + 1).includes('.')) {
		const embedded = parseIpv4(text.slice(lastColon + 1))
		if (embedded === undefined) return undefined
		head = text.slice(0, lastColon + 1)
		tail = embedded
		tailGroups = 2
	}
	const halves = head.split('::')
	if (halves.length > 2) return undefined
	const readGroups = (part: string): bigint[] | undefined => {
		if (part === '') return []
		const groups: bigint[] = []
		for (const group of part.split(':')) {
			if (group === '') continue
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined
			groups.push(BigInt(Number.parseInt(group, 16)))
		}
		return groups
	}
	const left = readGroups(halves[0] ?? '')
	const right = readGroups(halves[1] ?? '')
	if (left === undefined || right === undefined) return undefined
	const present = left.length + right.length + tailGroups
	if (present > 8) return undefined
	if (halves.length === 1 && present !== 8) return undefined
	const zeros = 8 - present
	const groups = [...left, ...Array.from({ length: zeros }, () => 0n), ...right]
	let value = 0n
	for (const group of groups) value = (value << 16n) | group
	if (tailGroups === 2) value = (value << 32n) | tail
	return value
}

/**
 * A CIDR, or `undefined` when it is not one this check can read. Host bits
 * are masked off rather than rejected: `10.0.0.1/8` and `10.0.0.0/8` name the
 * same block, and an operator who wrote the first meant the second.
 */
export function parseCidr(text: unknown): ParsedCidr | undefined {
	if (typeof text !== 'string') return undefined
	const slash = text.indexOf('/')
	if (slash < 0) return undefined
	const address = text.slice(0, slash)
	const prefix = text.slice(slash + 1)
	if (!/^\d{1,3}$/.test(prefix)) return undefined
	const bits = Number(prefix)
	if (address.includes(':')) {
		const value = parseIpv6(address)
		if (value === undefined || bits > 128) return undefined
		return { version: 6, base: maskAddress(value, bits, 128), bits }
	}
	const value = parseIpv4(address)
	if (value === undefined || bits > 32) return undefined
	return { version: 4, base: maskAddress(value, bits, 32), bits }
}

function maskAddress(value: bigint, bits: number, width: number): bigint {
	if (bits === 0) return 0n
	const host = BigInt(width - bits)
	return (value >> host) << host
}

/** Every address of `inner` is an address of `outer`. */
function cidrContains(outer: ParsedCidr, inner: ParsedCidr): boolean {
	if (outer.version !== inner.version) return false
	if (outer.bits > inner.bits) return false
	const width = outer.version === 4 ? 32 : 128
	return maskAddress(inner.base, outer.bits, width) === outer.base
}

/** They share at least one address — i.e. one contains the other. */
function cidrsOverlap(a: ParsedCidr, b: ParsedCidr): boolean {
	return cidrContains(a, b) || cidrContains(b, a)
}

// ---------------------------------------------------------------------------
// What the configured translation permits
// ---------------------------------------------------------------------------

/** One port, or a range of them, on one protocol. `start` absent is every port. */
interface PortRange {
	/** `undefined` is EVERY protocol — how Cilium spells `ANY`. Core defaults to TCP. */
	readonly protocol?: string
	readonly start?: number
	readonly end?: number
}

/** A port list, `'all'` for the absent/empty one, `'unreadable'` for a shape this check cannot read. */
type PortSet = 'all' | readonly PortRange[] | 'unreadable'

/** A destination, as either side of the comparison names it. */
type PolicyPeer =
	| { readonly kind: 'everything' }
	| {
			readonly kind: 'cidr'
			readonly cidr: ParsedCidr
			readonly except: readonly ParsedCidr[]
			readonly text: string
	  }
	| {
			readonly kind: 'selector'
			readonly namespaceSelector?: unknown
			readonly podSelector?: unknown
			readonly text: string
	  }

interface AllowedDestination {
	readonly peer: PolicyPeer
	readonly ports: 'all' | readonly PortRange[]
}

/**
 * Everything the configured translation lets out, in the one shape the union
 * check compares against.
 *
 * Built from the manifest {@link translateEgressPolicy} just produced for
 * every core kind, so there is no second statement anywhere of what
 * `deny-all` or `public-internet` permit — the emitted object IS the
 * statement, and a test asserts each translation is within its own
 * allowance. The Cilium kinds are the one exception and say so: a
 * `CiliumNetworkPolicy`'s DNS-visibility rule is read into the core-shaped
 * destination it is equivalent to (UDP/TCP 53 to the resolver's pods), so
 * that a core `NetworkPolicy` allowing exactly cluster DNS is not reported as
 * widening a hostname allowlist that already allows it.
 */
export interface EgressAllowance {
	readonly destinations: readonly AllowedDestination[]
	/** `toFQDNs` names a `static`/`resolver` translation allows. Empty for every core kind. */
	readonly fqdns: readonly string[]
	readonly permitsEverything: boolean
	readonly permitsNothing: boolean
	/** The configured kind, for the refusal message. */
	readonly policyKind: KubernetesEgressPolicy['kind']
}

function readPortRanges(ports: unknown, defaultProtocol: string | undefined): PortSet {
	const entries = readList(ports)
	if (entries === 'unreadable') return 'unreadable'
	// Absent or empty `ports` on an egress rule means EVERY port.
	if (entries === undefined || entries.length === 0) return 'all'
	const ranges: PortRange[] = []
	for (const entry of entries) {
		if (!isRecord(entry)) return 'unreadable'
		const rawProtocol = entry.protocol
		if (rawProtocol !== undefined && typeof rawProtocol !== 'string') return 'unreadable'
		const protocol =
			rawProtocol === undefined
				? defaultProtocol
				: rawProtocol.toUpperCase() === 'ANY'
					? undefined
					: rawProtocol.toUpperCase()
		const endPort = entry.endPort
		if (endPort !== undefined && typeof endPort !== 'number') return 'unreadable'
		const raw = entry.port
		if (raw === undefined) {
			ranges.push(protocol === undefined ? {} : { protocol })
			continue
		}
		const port = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN
		// A NAMED container port. Resolving it needs the destination pod's own
		// container spec, which this check never has.
		if (!Number.isInteger(port)) return 'unreadable'
		ranges.push({
			...(protocol !== undefined ? { protocol } : {}),
			start: port,
			...(typeof endPort === 'number' ? { end: endPort } : {}),
		})
	}
	return ranges
}

function readCorePeer(peer: unknown): PolicyPeer | undefined {
	if (!isRecord(peer)) return undefined
	const { ipBlock, podSelector, namespaceSelector } = peer
	if (ipBlock !== undefined) {
		if (!isRecord(ipBlock)) return undefined
		const cidr = parseCidr(ipBlock.cidr)
		if (cidr === undefined) return undefined
		const rawExcept = readList(ipBlock.except)
		if (rawExcept === 'unreadable') return undefined
		const except: ParsedCidr[] = []
		for (const entry of rawExcept ?? []) {
			const parsed = parseCidr(entry)
			if (parsed === undefined) return undefined
			except.push(parsed)
		}
		return { kind: 'cidr', cidr, except, text: JSON.stringify(ipBlock) }
	}
	if (podSelector === undefined && namespaceSelector === undefined) {
		// A peer naming none of the three constrains nothing. The API server
		// rejects it on admission, so an object carrying one did not come from
		// there and is not read as anything.
		return undefined
	}
	if (!selectorIsReadable(podSelector) || !selectorIsReadable(namespaceSelector)) return undefined
	return {
		kind: 'selector',
		...(namespaceSelector !== undefined ? { namespaceSelector } : {}),
		...(podSelector !== undefined ? { podSelector } : {}),
		text: JSON.stringify(peer),
	}
}

/**
 * The allowance a translated policy expresses. See {@link EgressAllowance}.
 */
export function egressAllowance(translated: KubernetesTranslatedEgressPolicy): EgressAllowance {
	const spec = (translated.manifest as { readonly spec: Record<string, unknown> }).spec
	// This module built the manifest a line ago, so `spec.egress` is always a
	// list here; the narrowing exists so the allowance is derived from the
	// object itself rather than from a second statement of what each kind
	// permits, and an impossible shape yields an allowance that permits
	// nothing rather than one that permits anything.
	const emitted = readList(spec.egress)
	const rules = emitted === undefined || emitted === 'unreadable' ? [] : emitted
	if (translated.kind === 'CiliumNetworkPolicy') {
		const fqdns: string[] = []
		for (const rule of rules) {
			if (!isRecord(rule)) continue
			for (const entry of readList(rule.toFQDNs) ?? []) {
				if (isRecord(entry) && typeof entry.matchName === 'string') fqdns.push(entry.matchName)
			}
		}
		return {
			// The core-shaped reading of CILIUM_DNS_VISIBILITY_RULE — the one
			// place in this module where one resource's rule is restated in the
			// other's vocabulary, so that a core policy allowing exactly cluster
			// DNS is not reported as widening a translation that already allows
			// it. Nothing else about a Cilium translation is restated: an
			// allowlist of names has no core spelling at all.
			destinations: [
				{
					peer: {
						kind: 'selector',
						namespaceSelector: {
							matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
						},
						podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
						text: 'the cluster resolver',
					},
					ports: [{ start: 53 }],
				},
			],
			fqdns,
			permitsEverything: false,
			permitsNothing: false,
			policyKind: translated.policyKind,
		}
	}
	const destinations: AllowedDestination[] = []
	let permitsEverything = false
	for (const rule of rules) {
		if (!isRecord(rule)) continue
		const ports = readPortRanges(rule.ports, 'TCP')
		if (ports === 'unreadable') continue
		const to = readList(rule.to)
		if (to === 'unreadable') continue
		if (to === undefined || to.length === 0) {
			destinations.push({ peer: { kind: 'everything' }, ports })
			if (ports === 'all') permitsEverything = true
			continue
		}
		for (const peer of to) {
			const read = readCorePeer(peer)
			if (read !== undefined) destinations.push({ peer: read, ports })
		}
	}
	return {
		destinations,
		fqdns: [],
		permitsEverything,
		permitsNothing: rules.length === 0,
		policyKind: translated.policyKind,
	}
}

// ---------------------------------------------------------------------------
// Is one policy's rule inside the translation
// ---------------------------------------------------------------------------

function protocolCovers(allowed: string | undefined, wanted: string | undefined): boolean {
	// `undefined` on the allowed side is EVERY protocol; on the wanted side it
	// is also every protocol, which only an every-protocol allowance covers.
	return allowed === undefined || allowed === wanted
}

function portRangeCovers(allowed: PortRange, wanted: PortRange): boolean {
	if (!protocolCovers(allowed.protocol, wanted.protocol)) return false
	if (allowed.start === undefined) return true
	if (wanted.start === undefined) return false
	const allowedEnd = allowed.end ?? allowed.start
	const wantedEnd = wanted.end ?? wanted.start
	return wanted.start >= allowed.start && wantedEnd <= allowedEnd
}

function portsCover(allowed: 'all' | readonly PortRange[], wanted: PortRange): boolean {
	if (allowed === 'all') return true
	return allowed.some((range) => portRangeCovers(range, wanted))
}

/** Every constraint `outer` places, `inner` places too — so `inner` selects a subset. */
function selectorIsNarrower(outer: unknown, inner: unknown): boolean {
	if (outer === undefined) return true
	if (!isRecord(outer)) return false
	const outerLabels = outer.matchLabels
	const outerExpressions = readList(outer.matchExpressions)
	if (outerExpressions === 'unreadable') return false
	if (outerLabels === undefined && (outerExpressions ?? []).length === 0) {
		// An EMPTY selector is "everything of this kind", which every selector
		// of that kind is inside.
		return true
	}
	if (inner === undefined || !isRecord(inner)) return false
	if (outerLabels !== undefined) {
		if (!isRecord(outerLabels)) return false
		const innerLabels = inner.matchLabels
		if (!isRecord(innerLabels)) return false
		for (const [key, value] of Object.entries(outerLabels)) {
			if (!Object.hasOwn(innerLabels, key) || innerLabels[key] !== value) return false
		}
	}
	const innerExpressions = readList(inner.matchExpressions)
	if (innerExpressions === 'unreadable') return false
	for (const expression of outerExpressions ?? []) {
		if (!(innerExpressions ?? []).some((candidate) => isDeepStrictEqual(candidate, expression))) {
			return false
		}
	}
	return true
}

/** Is every address `wanted` admits also admitted by `allowed`. */
function peerIsWithin(allowed: PolicyPeer, wanted: PolicyPeer): boolean {
	if (allowed.kind === 'everything') return true
	if (wanted.kind === 'everything') return false
	if (allowed.kind === 'cidr') {
		if (wanted.kind !== 'cidr') return false
		if (!cidrContains(allowed.cidr, wanted.cidr)) return false
		// Every hole the allowance carves out of its block has to be a hole in
		// this peer too, or this peer reaches an address the translation does
		// not allow. Coverage by a UNION of the peer's own `except` entries is
		// not attempted: one entry has to contain it.
		for (const hole of allowed.except) {
			if (!cidrsOverlap(hole, wanted.cidr)) continue
			if (!wanted.except.some((own) => cidrContains(own, hole))) return false
		}
		return true
	}
	if (wanted.kind !== 'selector') return false
	// A namespaceSelector the allowance omits means "this namespace"; a peer
	// that names namespaces reaches further than that.
	if (allowed.namespaceSelector === undefined && wanted.namespaceSelector !== undefined) {
		return false
	}
	return (
		selectorIsNarrower(allowed.namespaceSelector, wanted.namespaceSelector) &&
		selectorIsNarrower(allowed.podSelector, wanted.podSelector)
	)
}

function destinationIsAllowed(
	allowance: EgressAllowance,
	peer: PolicyPeer,
	ports: 'all' | readonly PortRange[],
): boolean {
	const wanted: readonly PortRange[] = ports === 'all' ? [{}] : ports
	return wanted.every((range) =>
		allowance.destinations.some(
			(destination) => peerIsWithin(destination.peer, peer) && portsCover(destination.ports, range),
		),
	)
}

/** One egress rule, judged against the translation. */
export interface EgressRuleVerdict {
	readonly beyond: boolean | 'unknown'
	readonly detail?: string
}

function describePeer(peer: PolicyPeer): string {
	if (peer.kind === 'everything') return 'every destination'
	return peer.text
}

function describePorts(ports: 'all' | readonly PortRange[]): string {
	if (ports === 'all') return 'every port'
	return ports
		.map((range) =>
			range.start === undefined
				? `every ${range.protocol ?? ''} port`.trim()
				: `${range.protocol ?? 'any'} ${range.start}${range.end !== undefined ? `-${range.end}` : ''}`,
		)
		.join(', ')
}

function coreEgressRuleVerdict(rule: unknown, allowance: EgressAllowance): EgressRuleVerdict {
	// Under a translation that permits nothing, the rule's own shape does not
	// matter and is not read: ANY egress rule on a policy selecting this pod
	// lets something out.
	if (allowance.permitsNothing) {
		return {
			beyond: true,
			detail: 'an egress rule, where the configured translation permits no egress at all',
		}
	}
	if (!isRecord(rule))
		return {
			beyond: 'unknown',
			detail: 'an egress rule that is not an object',
		}
	const ports = readPortRanges(rule.ports, 'TCP')
	if (ports === 'unreadable') {
		return {
			beyond: 'unknown',
			detail: 'a ports entry this check cannot read',
		}
	}
	const to = readList(rule.to)
	if (to === 'unreadable') {
		return { beyond: 'unknown', detail: "a 'to' that is not a list of peers" }
	}
	if (to === undefined || to.length === 0) {
		// No `to` on an egress rule means EVERY destination.
		return allowance.permitsEverything
			? { beyond: false }
			: {
					beyond: true,
					detail: `no 'to' peers, so every destination is reachable on ${describePorts(ports)}`,
				}
	}
	for (const peer of to) {
		const read = readCorePeer(peer)
		if (read === undefined) {
			return {
				beyond: 'unknown',
				detail: `a 'to' peer this check cannot read (${JSON.stringify(peer)})`,
			}
		}
		if (!destinationIsAllowed(allowance, read, ports)) {
			const wideOpen = corePeerIsWideOpen(peer) === true
			return {
				beyond: true,
				detail: `${wideOpen ? 'a wide-open ' : 'a '}'to' peer ${describePeer(read)} on ${describePorts(ports)}, which a '${allowance.policyKind}' translation does not allow`,
			}
		}
	}
	return { beyond: false }
}

/** Every `to…` field the Cilium CRD declares. A rule naming none of them is port-only. */
const CILIUM_DESTINATION_FIELDS = [
	'toEndpoints',
	'toEntities',
	'toCIDR',
	'toCIDRSet',
	'toFQDNs',
	'toServices',
	'toGroups',
	'toNodes',
] as const

/**
 * The label set a Cilium endpoint selector names, read back as the core
 * `namespaceSelector`/`podSelector` pair it is equivalent to, so the one
 * `peerIsWithin` serves both resource kinds. `undefined` when the selector
 * uses anything this reading cannot map — a label source that is not a pod
 * label, or a match expression.
 */
function ciliumEndpointPeer(selector: unknown): PolicyPeer | undefined {
	if (!isRecord(selector)) return undefined
	if (selector.matchExpressions !== undefined) return undefined
	const matchLabels = selector.matchLabels
	if (!isRecord(matchLabels)) return undefined
	const podLabels: Record<string, string> = {}
	let namespace: string | undefined
	for (const [rawKey, value] of Object.entries(matchLabels)) {
		if (typeof value !== 'string') return undefined
		const key = ciliumSelectorKey(rawKey)
		if (key === undefined) return undefined
		if (key === 'io.kubernetes.pod.namespace') {
			namespace = value
			continue
		}
		podLabels[key] = value
	}
	return {
		kind: 'selector',
		...(namespace !== undefined
			? {
					namespaceSelector: {
						matchLabels: { 'kubernetes.io/metadata.name': namespace },
					},
				}
			: {}),
		podSelector: { matchLabels: podLabels },
		text: JSON.stringify(selector),
	}
}

function ciliumEgressRuleVerdict(rule: unknown, allowance: EgressAllowance): EgressRuleVerdict {
	if (allowance.permitsNothing) {
		return {
			beyond: true,
			detail: 'an egress rule, where the configured translation permits no egress at all',
		}
	}
	if (!isRecord(rule))
		return {
			beyond: 'unknown',
			detail: 'an egress rule that is not an object',
		}
	// A Cilium rule carries its ports one level deeper, and a port entry with
	// no protocol means ANY rather than TCP.
	const toPorts = readList(rule.toPorts)
	if (toPorts === 'unreadable') {
		return { beyond: 'unknown', detail: 'a toPorts that is not a list' }
	}
	const portEntries: unknown[] = []
	for (const entry of toPorts ?? []) {
		if (!isRecord(entry)) {
			return { beyond: 'unknown', detail: 'a toPorts entry that is not an object' }
		}
		const list = readList(entry.ports)
		if (list === 'unreadable') {
			return { beyond: 'unknown', detail: 'a toPorts ports field that is not a list' }
		}
		// An entry with no `ports` at all bounds nothing, so the rule reaches
		// every port — exactly what an absent `toPorts` means.
		if (list === undefined || list.length === 0) {
			portEntries.length = 0
			break
		}
		portEntries.push(...list)
	}
	const ports = readPortRanges(portEntries, undefined)
	if (ports === 'unreadable') {
		return { beyond: 'unknown', detail: 'a toPorts entry this check cannot read' }
	}
	const fields = new Map<(typeof CILIUM_DESTINATION_FIELDS)[number], readonly unknown[]>()
	for (const field of CILIUM_DESTINATION_FIELDS) {
		const list = readList(rule[field])
		if (list === 'unreadable') {
			return {
				beyond: 'unknown',
				detail: `a ${field} that is not a list of peers`,
			}
		}
		if (list !== undefined && list.length > 0) fields.set(field, list)
	}
	if (fields.size === 0) {
		return allowance.permitsEverything
			? { beyond: false }
			: {
					beyond: true,
					detail: `a port-only egress rule, so every destination is reachable on ${describePorts(ports)}`,
				}
	}
	for (const entity of fields.get('toEntities') ?? []) {
		if (typeof entity !== 'string') {
			return {
				beyond: 'unknown',
				detail: 'a toEntities entry that is not an entity name',
			}
		}
		if (!allowance.permitsEverything) {
			return {
				beyond: true,
				detail: `toEntities '${entity}', which a '${allowance.policyKind}' translation does not allow`,
			}
		}
	}
	for (const field of ['toCIDR', 'toCIDRSet'] as const) {
		for (const entry of fields.get(field) ?? []) {
			const peer =
				field === 'toCIDR'
					? readCorePeer({ ipBlock: { cidr: entry } })
					: isRecord(entry)
						? readCorePeer({
								ipBlock: { cidr: entry.cidr, except: entry.except },
							})
						: undefined
			if (peer === undefined) {
				return {
					beyond: 'unknown',
					detail: `a ${field} entry this check cannot read`,
				}
			}
			if (!destinationIsAllowed(allowance, peer, ports)) {
				return {
					beyond: true,
					detail: `${field} ${describePeer(peer)} on ${describePorts(ports)}, which a '${allowance.policyKind}' translation does not allow`,
				}
			}
		}
	}
	for (const entry of fields.get('toFQDNs') ?? []) {
		if (!isRecord(entry)) {
			return {
				beyond: 'unknown',
				detail: 'a toFQDNs entry that is not an object',
			}
		}
		const matchName = entry.matchName
		if (typeof matchName !== 'string' || !allowance.fqdns.includes(matchName)) {
			return {
				beyond: true,
				detail: `toFQDNs ${JSON.stringify(entry)}, which a '${allowance.policyKind}' translation does not allow`,
			}
		}
	}
	for (const selector of fields.get('toEndpoints') ?? []) {
		const peer = ciliumEndpointPeer(selector)
		if (peer === undefined) {
			return {
				beyond: 'unknown',
				detail: 'a toEndpoints entry this check cannot read as a selector',
			}
		}
		if (!destinationIsAllowed(allowance, peer, ports)) {
			return {
				beyond: true,
				detail: `toEndpoints ${describePeer(peer)} on ${describePorts(ports)}, which a '${allowance.policyKind}' translation does not allow`,
			}
		}
	}
	for (const field of ['toServices', 'toGroups', 'toNodes'] as const) {
		if (fields.has(field)) {
			return {
				beyond: 'unknown',
				detail: `a ${field} rule, whose destinations this check cannot enumerate`,
			}
		}
	}
	return { beyond: false }
}

// ---------------------------------------------------------------------------
// Normalising the policies that select this pod
// ---------------------------------------------------------------------------

/** The pod the union check is about. */
export interface EgressVerificationTarget {
	readonly namespace: string
	/**
	 * The pod's REAL labels — for a directly created Sandbox the labels the
	 * create body stamps (known before the POST, so a refusal leaves no
	 * Sandbox and no PVC behind), for a claimed one the bound pod's own
	 * `metadata.labels`. The same value the ingress check is given, for the
	 * same reason: a name proves an object exists, a label is what a selector
	 * actually matches.
	 */
	readonly podLabels: Readonly<Record<string, string>>
	readonly engine: KubernetesEgressEngine
	/** How the refusal names the thing being created, e.g. `Sandbox namzu-ws-demo`. */
	readonly subject: string
}

/** What one examined policy turned out to be. One line of the refusal. */
export type EgressPolicyVerdict =
	/** Selects the pod and lets out nothing the translation does not. */
	| 'within'
	/** Selects the pod and allows egress the translation does not. */
	| 'widens-egress'
	/** Its selector does not match the pod's labels. */
	| 'does-not-select'
	/** Selects the pod but does not enforce egress, so its egress block is inert. */
	| 'not-egress-scoped'
	/** Contains something this check cannot decide. */
	| 'not-evaluable'

/** One policy, as the refusal reports it. */
export interface ExaminedEgressPolicy {
	readonly kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
	readonly name: string
	readonly verdict: EgressPolicyVerdict
	/** Why, for every verdict that is not a plain match or non-match. */
	readonly detail?: string
}

/**
 * Which of the three refusals this is — three different operator actions, so
 * they are carried apart rather than folded into one message:
 *
 *  - `policy-widens-egress` — narrow or delete the policy that lets more out
 *    than `config.egress` says.
 *  - `no-enforcing-policy` — nothing puts this pod in egress default-deny, so
 *    the translation is not the boundary; apply a policy that selects these
 *    labels.
 *  - `not-evaluable` — this check cannot decide; grant the missing verb, fix
 *    the unreadable policy, or declare `egress.verify: 'named-object-only'`.
 */
export type EgressPolicyRefusal = 'policy-widens-egress' | 'no-enforcing-policy' | 'not-evaluable'

/**
 * One policy, reduced to the three questions the union rule asks: does it
 * select this pod, does it put it in egress default-deny, and does anything
 * it allows fall outside the configured translation.
 */
export interface EgressPolicyDocument {
	readonly kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
	readonly name: string
	readonly selects: SelectorMatch
	/**
	 * Does this policy put the pod into egress DEFAULT-DENY — the only thing
	 * that makes the translation a boundary at all. A core policy whose
	 * `policyTypes` leaves Egress out does not (and the API server ignores its
	 * `egress` block outright), and neither does a Cilium rule carrying
	 * `enableDefaultDeny.egress: false`.
	 */
	readonly enforcesEgress: boolean
	readonly rules: readonly EgressRuleVerdict[]
	/** Set when the OBJECT could not be read. It decides alone. */
	readonly unreadable?: string
}

function unreadableEgressPolicy(
	kind: EgressPolicyDocument['kind'],
	name: string,
	detail: string,
): EgressPolicyDocument {
	return {
		kind,
		name,
		selects: 'unknown',
		enforcesEgress: false,
		rules: [],
		unreadable: detail,
	}
}

/** Every core `NetworkPolicy` in the list, reduced to {@link EgressPolicyDocument}. */
export function readCoreEgressPolicies(
	items: readonly unknown[],
	target: EgressVerificationTarget,
	allowance: EgressAllowance,
): EgressPolicyDocument[] {
	return items.map((item, index) => {
		const name = policyName(item, index)
		if (!isRecord(item)) {
			return unreadableEgressPolicy(
				'NetworkPolicy',
				name,
				'a list entry that is not a policy object',
			)
		}
		const spec = item.spec
		if (!isRecord(spec)) {
			return unreadableEgressPolicy('NetworkPolicy', name, 'a spec that is not an object')
		}
		const policyTypes = readList(spec.policyTypes)
		if (policyTypes === 'unreadable') {
			return unreadableEgressPolicy('NetworkPolicy', name, 'a spec.policyTypes that is not a list')
		}
		const rules = readList(spec.egress)
		if (rules === 'unreadable') {
			return unreadableEgressPolicy(
				'NetworkPolicy',
				name,
				'a spec.egress that is not a list of rules',
			)
		}
		// An ABSENT `policyTypes` is defaulted by the API server from the blocks
		// the object carries: Egress appears exactly when `spec.egress` does.
		// This is the opposite of the ingress default, where Egress's absence is
		// the thing that has to be spelled out.
		const enforcesEgress =
			policyTypes === undefined ? rules !== undefined : policyTypes.includes('Egress')
		return {
			kind: 'NetworkPolicy',
			name,
			selects: matchesLabelSelector(spec.podSelector, target.podLabels),
			enforcesEgress,
			// An `egress` block under a `policyTypes` that leaves Egress out is
			// ignored by the API server itself: it neither bounds nor widens.
			rules: enforcesEgress
				? (rules ?? []).map((rule) => coreEgressRuleVerdict(rule, allowance))
				: [],
		}
	})
}

/** Every `CiliumNetworkPolicy` in the list, reduced the same way. */
export function readCiliumEgressPolicies(
	items: readonly unknown[],
	target: EgressVerificationTarget,
	allowance: EgressAllowance,
): EgressPolicyDocument[] {
	const identity = ciliumIdentityLabels(target.podLabels, target.namespace)
	const documents: EgressPolicyDocument[] = []
	for (const [index, item] of items.entries()) {
		const name = policyName(item, index)
		if (!isRecord(item)) {
			documents.push(
				unreadableEgressPolicy(
					'CiliumNetworkPolicy',
					name,
					'a list entry that is not a policy object',
				),
			)
			continue
		}
		// The CRD carries EITHER one `spec` or a `specs` list, and a rule in
		// either enforces. Reading only `spec` would miss a whole policy.
		const specs: unknown[] = []
		if (item.spec !== undefined && item.spec !== null) specs.push(item.spec)
		const more = readList(item.specs)
		if (more === 'unreadable') {
			documents.push(
				unreadableEgressPolicy(
					'CiliumNetworkPolicy',
					name,
					'a specs that is not a list of rule specs',
				),
			)
			continue
		}
		for (const spec of more ?? []) specs.push(spec)
		if (specs.length === 0) {
			documents.push(
				unreadableEgressPolicy('CiliumNetworkPolicy', name, 'neither a spec nor a specs list'),
			)
			continue
		}
		for (const spec of specs) {
			const document = readCiliumEgressRuleSpec(spec, name, identity, allowance)
			if (document !== undefined) documents.push(document)
		}
	}
	return documents
}

/** One `spec`/`specs` entry. `undefined` when it is node-scoped — see below. */
function readCiliumEgressRuleSpec(
	spec: unknown,
	name: string,
	identity: Readonly<Record<string, string>>,
	allowance: EgressAllowance,
): EgressPolicyDocument | undefined {
	const unreadable = (detail: string) => unreadableEgressPolicy('CiliumNetworkPolicy', name, detail)
	if (!isRecord(spec)) return unreadable('a rule spec that is not an object')
	// A node-scoped rule selects nodes, never pods.
	if (spec.nodeSelector !== undefined) return undefined
	const rules = readList(spec.egress)
	if (rules === 'unreadable') return unreadable('a spec.egress that is not a list of rules')
	const egressDeny = readList(spec.egressDeny)
	if (egressDeny === 'unreadable')
		return unreadable('a spec.egressDeny that is not a list of rules')
	let enforcesEgress = rules !== undefined || egressDeny !== undefined
	const enableDefaultDeny = spec.enableDefaultDeny
	if (enableDefaultDeny !== undefined) {
		if (!isRecord(enableDefaultDeny))
			return unreadable('an enableDefaultDeny that is not an object')
		const forEgress = enableDefaultDeny.egress
		if (forEgress !== undefined && typeof forEgress !== 'boolean') {
			return unreadable('an enableDefaultDeny.egress that is not a boolean')
		}
		if (forEgress === false) enforcesEgress = false
	}
	return {
		kind: 'CiliumNetworkPolicy',
		name,
		selects: matchesLabelSelector(spec.endpointSelector, identity, ciliumSelectorKey),
		enforcesEgress,
		// `egressDeny` rules are not read: a deny rule can only narrow what
		// leaves the pod, and this check refuses widening. Allow rules are read
		// whatever `enableDefaultDeny` says, because what a rule admits it
		// admits — it simply may not be the policy that default-denies.
		rules: (rules ?? []).map((rule) => ciliumEgressRuleVerdict(rule, allowance)),
	}
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface EgressUnionDecision {
	readonly examined: readonly ExaminedEgressPolicy[]
	/** Absent when every selecting policy stays inside the translation. */
	readonly refusal?: {
		readonly kind: EgressPolicyRefusal
		readonly summary: string
	}
}

/**
 * The union rule, applied. Pure — no I/O, no client, no clock — so every
 * shape that has to be refused can be asserted one per test.
 *
 * Kubernetes UNIONS every policy selecting a pod: traffic leaves if ANY
 * selecting policy allows it. So one policy allowing more than the
 * translation is the finding however many narrower ones sit beside it, and a
 * pod no policy default-denies has no egress boundary at all whatever the
 * named object says.
 */
export function decideEgressUnion(
	documents: readonly EgressPolicyDocument[],
	allowance: EgressAllowance,
): EgressUnionDecision {
	const examined: ExaminedEgressPolicy[] = []
	let enforcing = 0
	let widening: ExaminedEgressPolicy | undefined
	let undecided: ExaminedEgressPolicy | undefined

	for (const document of documents) {
		const base = { kind: document.kind, name: document.name } as const
		if (document.unreadable !== undefined) {
			const entry: ExaminedEgressPolicy = {
				...base,
				verdict: 'not-evaluable',
				detail: document.unreadable,
			}
			examined.push(entry)
			undecided ??= entry
			continue
		}
		if (document.selects === 'no') {
			examined.push({ ...base, verdict: 'does-not-select' })
			continue
		}
		if (document.selects === 'unknown') {
			const entry: ExaminedEgressPolicy = {
				...base,
				verdict: 'not-evaluable',
				detail: 'its selector uses something this check cannot evaluate against pod labels',
			}
			examined.push(entry)
			undecided ??= entry
			continue
		}
		const beyondRule = document.rules.find((rule) => rule.beyond === true)
		if (beyondRule !== undefined) {
			const entry: ExaminedEgressPolicy = {
				...base,
				verdict: 'widens-egress',
				...(beyondRule.detail !== undefined ? { detail: beyondRule.detail } : {}),
			}
			examined.push(entry)
			widening ??= entry
			continue
		}
		const unknownRule = document.rules.find((rule) => rule.beyond === 'unknown')
		if (unknownRule !== undefined) {
			const entry: ExaminedEgressPolicy = {
				...base,
				verdict: 'not-evaluable',
				...(unknownRule.detail !== undefined ? { detail: unknownRule.detail } : {}),
			}
			examined.push(entry)
			undecided ??= entry
			continue
		}
		if (!document.enforcesEgress) {
			examined.push({
				...base,
				verdict: 'not-egress-scoped',
				detail: 'it selects the pod but default-denies nothing on egress',
			})
			continue
		}
		examined.push({ ...base, verdict: 'within' })
		enforcing += 1
	}

	if (widening !== undefined) {
		return {
			examined,
			refusal: {
				kind: 'policy-widens-egress',
				summary: `${widening.kind}/${widening.name} selects this pod and allows ${widening.detail ?? 'egress the configured translation does not'}.`,
			},
		}
	}
	if (undecided !== undefined) {
		return {
			examined,
			refusal: {
				kind: 'not-evaluable',
				summary: `${undecided.kind}/${undecided.name} contains ${undecided.detail ?? 'something this check cannot evaluate'}, so what this pod may reach cannot be decided from the cluster's own objects.`,
			},
		}
	}
	// `allow-all` asks for no boundary, so a pod nothing default-denies is
	// exactly what it configured; every other kind needs a policy that
	// actually puts this pod in egress default-deny, or the translation is a
	// manifest nobody enforces.
	if (enforcing === 0 && !allowance.permitsEverything) {
		return {
			examined,
			refusal: {
				kind: 'no-enforcing-policy',
				summary: `no applied policy puts this pod in egress default-deny, so a '${allowance.policyKind}' translation bounds nothing it sends.`,
			},
		}
	}
	return { examined }
}

/**
 * The named refusal. Distinct from {@link KubernetesEgressPolicyMismatchError}
 * — which is about the ONE named object drifting from the translation — and
 * from `KubernetesIngressPolicyError`, which is about the agent port being
 * reachable. An operator debugging a release that ships all three tells them
 * apart by class and by the first clause of the message.
 *
 * It carries the pod's labels and EVERY policy examined, with a verdict each,
 * because that list is the operator's whole debugging session: "why does my
 * policy not count?" is answered by the line saying it did not select these
 * labels.
 */
export class KubernetesEgressPolicyUnionError extends Error {
	override readonly name = 'KubernetesEgressPolicyUnionError'

	constructor(
		readonly refusal: EgressPolicyRefusal,
		readonly subject: string,
		readonly podLabels: Readonly<Record<string, string>>,
		readonly policyKind: KubernetesEgressPolicy['kind'],
		readonly examined: readonly ExaminedEgressPolicy[],
		summary: string,
		/** Empty on every decision made from policies that WERE read. */
		readonly unread: readonly UnreadPolicySource[] = [],
	) {
		super(
			`kubernetes: refusing ${subject} — ${summary} config.egress.policy is '${policyKind}' and the pod's labels are ${formatLabels(podLabels)}. ${formatExaminedEgress(examined, unread)} Kubernetes UNIONS every policy selecting a pod, so what leaves this pod is everything ANY of them allows — a second policy widens egress however exactly the named object matches. ${formatEgressRemedy(refusal, unread)}`,
		)
	}
}

function formatExaminedEgress(
	examined: readonly ExaminedEgressPolicy[],
	unread: readonly UnreadPolicySource[],
): string {
	const lines = examined.map((entry) => {
		const detail = entry.detail !== undefined ? ` (${entry.detail})` : ''
		return `${entry.kind}/${entry.name}: ${entry.verdict}${detail}`
	})
	const read =
		lines.length === 0
			? 'No policy was read from the collections this check could enumerate.'
			: `Policies examined: ${lines.join('; ')}.`
	if (unread.length === 0) return read
	const missing = unread
		.map((source) => `${source.resource} at ${source.path} (${source.why}: ${source.reason})`)
		.join('; ')
	return `${read} NOT read, so nothing below is a statement about it: ${missing}.`
}

function formatEgressRemedy(
	refusal: EgressPolicyRefusal,
	unread: readonly UnreadPolicySource[],
): string {
	if (refusal === 'not-evaluable') {
		const forbidden = unread.some((source) => source.why === 'forbidden')
		return `${forbidden ? "Grant this backend's ServiceAccount 'list' on that resource, " : 'Fix or remove the policy named above, '}or set egress.verify: 'named-object-only' to check only the one named object, as every release before this one did.`
	}
	if (refusal === 'no-enforcing-policy') {
		return "Apply a NetworkPolicy whose podSelector matches the labels above and whose policyTypes includes 'Egress' (packages/sandbox/k8s/manifests/networkpolicy.yaml is this repo's baseline), or set egress.verify: 'named-object-only' if the boundary lives somewhere a namespaced Role cannot read."
	}
	return "Narrow or delete the policy named above so that nothing selecting these pods allows more than config.egress does, or set egress.verify: 'named-object-only' to go back to checking only the named object."
}

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

/**
 * Verify-not-trust, widened from one object to the union: list the
 * namespace's policies, evaluate every one that selects this pod against the
 * configured translation, and refuse unless nothing lets out more than
 * `config.egress` says.
 *
 * Runs beside the ingress check on every create path — before the POST for a
 * directly created Sandbox, where the labels are known and a refusal leaves
 * nothing behind, and after the bind for a claimed one, where the pool's own
 * template decides the labels and a refusal releases the claim through the
 * acquire path's cleanup.
 */
export async function verifyEgressPolicyUnion(
	client: KubernetesClient,
	translated: KubernetesTranslatedEgressPolicy,
	target: EgressVerificationTarget,
	signal?: AbortSignal,
): Promise<void> {
	const allowance = egressAllowance(translated)
	const documents: EgressPolicyDocument[] = []
	try {
		documents.push(
			...readCoreEgressPolicies(
				await listPolicies(
					client,
					networkPolicyCollectionPath(target.namespace),
					'networkpolicies',
					signal,
				),
				target,
				allowance,
			),
		)
		if (target.engine === 'cilium') {
			documents.push(
				...readCiliumEgressPolicies(
					await listPolicies(
						client,
						ciliumNetworkPolicyCollectionPath(target.namespace),
						'ciliumnetworkpolicies',
						signal,
					),
					target,
					allowance,
				),
			)
		}
	} catch (err) {
		if (!(err instanceof UnreadPolicyCollection)) throw err
		throw new KubernetesEgressPolicyUnionError(
			'not-evaluable',
			target.subject,
			target.podLabels,
			allowance.policyKind,
			decideEgressUnion(documents, allowance).examined,
			err.summary,
			[err.source],
		)
	}

	const decision = decideEgressUnion(documents, allowance)
	if (decision.refusal === undefined) return
	throw new KubernetesEgressPolicyUnionError(
		decision.refusal.kind,
		target.subject,
		target.podLabels,
		allowance.policyKind,
		decision.examined,
		decision.refusal.summary,
	)
}
