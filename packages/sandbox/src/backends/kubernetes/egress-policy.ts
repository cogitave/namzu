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
import { KubernetesAlreadyGoneError, type KubernetesClient } from './k8s-client.js'
import {
	CILIUM_NETWORK_POLICY_API_GROUP,
	CILIUM_NETWORK_POLICY_API_VERSION,
	CORE_NETWORK_POLICY_API_GROUP,
	CORE_NETWORK_POLICY_API_VERSION,
	ciliumNetworkPolicyPath,
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
	readonly policy: EgressPolicy
	/**
	 * Name of the `NetworkPolicy` (or `CiliumNetworkPolicy`, under the
	 * `'cilium'` engine) an operator applied. Defaults to
	 * {@link defaultEgressPolicyName}'s output for the configured
	 * `sandboxTemplateName`.
	 */
	readonly networkPolicyName?: string
	/** Default `'core'`. See the type doc. */
	readonly engine?: KubernetesEgressEngine
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
 * Synchronous, no-I/O precondition: can `policy.kind` be enforced under
 * `engine` at all. Deliberately decided from the KIND alone — a `resolver`
 * policy's `resolve()` is never invoked here, both because calling it just to
 * prove a refusal would be wasted work (and possibly a side effect the host
 * did not expect yet) and because this has to stay callable synchronously
 * from `buildKubernetesBackend`, which contacts nothing.
 */
export function assertEgressPolicyIsEnforceable(
	policy: EgressPolicy,
	engine: KubernetesEgressEngine,
): void {
	if ((policy.kind === 'static' || policy.kind === 'resolver') && engine !== 'cilium') {
		throw new KubernetesUnenforceableEgressPolicyError(policy.kind)
	}
}

/**
 * The cluster DNS egress rule every translated `NetworkPolicy` carries,
 * including on `deny-all`. See the module doc's "Why a NetworkPolicy always
 * allows the cluster's own DNS" section.
 */
const CLUSTER_DNS_EGRESS_RULE = {
	to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
	ports: [
		{ protocol: 'UDP', port: 53 },
		{ protocol: 'TCP', port: 53 },
	],
} as const

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
	egress: readonly Readonly<Record<string, unknown>>[],
): KubernetesTranslatedEgressPolicy {
	return {
		kind: 'NetworkPolicy',
		namespace: target.namespace,
		name: target.name,
		manifest: {
			apiVersion: `${CORE_NETWORK_POLICY_API_GROUP}/${CORE_NETWORK_POLICY_API_VERSION}`,
			kind: 'NetworkPolicy',
			metadata: { name: target.name, namespace: target.namespace },
			spec: {
				podSelector: { matchLabels: sandboxTemplateLabel(target.sandboxTemplateName) },
				policyTypes: ['Egress'],
				egress,
			},
		},
	}
}

function buildCiliumNetworkPolicy(
	target: EgressPolicyTarget,
	allowedHosts: readonly string[],
): KubernetesTranslatedEgressPolicy {
	return {
		kind: 'CiliumNetworkPolicy',
		namespace: target.namespace,
		name: target.name,
		manifest: {
			apiVersion: `${CILIUM_NETWORK_POLICY_API_GROUP}/${CILIUM_NETWORK_POLICY_API_VERSION}`,
			kind: 'CiliumNetworkPolicy',
			metadata: { name: target.name, namespace: target.namespace },
			spec: {
				endpointSelector: { matchLabels: sandboxTemplateLabel(target.sandboxTemplateName) },
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
	policy: EgressPolicy,
	engine: KubernetesEgressEngine,
	target: EgressPolicyTarget,
): Promise<KubernetesTranslatedEgressPolicy> {
	assertEgressPolicyIsEnforceable(policy, engine)

	switch (policy.kind) {
		case 'deny-all':
			return buildCoreNetworkPolicy(target, [CLUSTER_DNS_EGRESS_RULE])
		case 'allow-all':
			// No `to`/`ports` on an egress rule matches every destination and
			// every port. `CLUSTER_DNS_EGRESS_RULE` is a strict subset of this,
			// so it is folded in rather than listed twice.
			return buildCoreNetworkPolicy(target, [{}])
		case 'static':
			// `assertEgressPolicyIsEnforceable` already threw above unless
			// `engine === 'cilium'`, so reaching here means it did not.
			return buildCiliumNetworkPolicy(target, policy.allowedHosts)
		case 'resolver': {
			const allowedHosts = await policy.resolve()
			return buildCiliumNetworkPolicy(target, allowedHosts)
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
