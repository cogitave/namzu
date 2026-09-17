/**
 * Per-sandbox egress: one policy object per LIVE sandbox, written by this
 * host while the sandbox runs, so `Sandbox.setNetworkPolicy` means something
 * here instead of being omitted.
 *
 * ## Why this is a separate file from `egress-policy.ts`
 *
 * That one is about the boundary an OPERATOR applies and this backend only
 * ever reads: one object per backend, translated from config, verified and
 * never written. This one is about an object this backend CREATES, replaces
 * and lets the cluster collect — a different lifecycle, a different RBAC
 * grant, and the only place in `@namzu/sandbox` that writes a policy at all.
 * They share the manifest builder and the read-back comparator, which is the
 * point: two spellings of "what a namzu egress policy looks like" would be
 * one comparing itself against the other's shape.
 *
 * ## The shape
 *
 *  - **Name** `namzu-sbx-<uid>`, where the uid is the object the acquire
 *    created for this sandbox — the `SandboxClaim` on the pooled path, the
 *    `Sandbox` on the pool-less one. Unique per sandbox by construction, and
 *    derivable from the owner reference alone, which is what lets the
 *    admission policy check the two against each other.
 *  - **Selector** one per-sandbox pod label, composed by
 *    `composeAdditionalPodLabels` — the ONE composer — and carried onto the
 *    pod as claim-time metadata before the pod exists. Not patched onto a
 *    running pod: this backend holds no write verb on pods, and a label added
 *    after the fact would leave a window in which the policy selected nothing.
 *  - **Owner** an `ownerReferences` entry naming that same object, so
 *    `destroy()` deletes the claim and the cluster's garbage collector
 *    removes the policy. This backend issues no deletion of its own on
 *    teardown, which is what keeps a crashed host from leaking policies.
 *  - **Rules** the DNS-visibility rule plus one `toFQDNs` rule per allowed
 *    host — `SandboxNetworkPolicy.allowedHosts`'s own grammar, where
 *    `.example.com` means the domain and its subdomains. A `.domain` entry
 *    and `narrowing.tlsServerNames` are refused TOGETHER: a TLS server name
 *    is one exact SNI value and an expanded entry is a name plus a pattern,
 *    so no single value means both and the emitted policy would deny the
 *    domain it claims to allow.
 *
 * ## The fence is not a nicety
 *
 * Writing these needs `create`/`patch`/`delete` on the namespace's
 * `ciliumnetworkpolicies`, and RBAC has no way to say "only the objects you
 * own". A host holding those verbs could widen — or simply delete — the
 * operator's own baseline policy. So before the FIRST write, this module
 * proves an operator applied a `ValidatingAdmissionPolicy` and its binding,
 * and refuses with {@link KubernetesAdmissionFenceMissingError}, having
 * written nothing, if either is absent. The shipped example
 * (`k8s/manifests/validatingadmissionpolicy-cilium.yaml`) bounds the host
 * identity to this name prefix, an owner reference whose uid the name has to
 * match, ONE selector label whose VALUE is that owner's own name (the shape
 * alone would not bound anything — one label is exactly what selects every
 * sandbox pod in the namespace), `toFQDNs` entries that each name something
 * (`matchPattern: '*'` is a `toFQDNs` rule and is not an allowlist), the
 * kube-dns rule on port 53, no address-based or entity-based peers and no
 * ingress.
 *
 * ## Union, not replacement
 *
 * The cluster unions every policy selecting a pod, so what this writes ADDS
 * to whatever `config.egress.policy` translated to. Under a `no-network` or
 * `deny-all` baseline that makes the per-sandbox list the pod's whole
 * boundary, which is the deployment this capability is for; under
 * `allow-all` it adds nothing to a pod that could already reach everything,
 * and `setNetworkPolicy([])` there does not deny everything the way
 * `SandboxNetworkPolicy` describes. Nothing refuses that wiring — a
 * permissive baseline with per-sandbox additions is a legitimate deployment
 * — but it is not the one the SDK's sentence is about.
 *
 * ## What is NOT proven anywhere in this repository
 *
 * That any of it is ENFORCED. Enforcement is one CNI's data plane, and the
 * only cluster available here runs none — every object below is proved
 * against a fake API server, and its lifecycle, ownership, garbage collection
 * and admission refusals against a local single-node cluster. "The allowed
 * host answers and the disallowed one does not" is a statement about a
 * network, and it needs a cluster that enforces plus a positive control.
 */

import type { SandboxNetworkPolicy } from '@namzu/sdk'

import {
	type KubernetesEgressConfig,
	KubernetesNetworkPolicyHostError,
	type KubernetesPerSandboxEgressConfig,
	type KubernetesTranslatedEgressPolicy,
	PER_SANDBOX_NARROWING_REFUSAL,
	assertHostsFitNarrowing,
	buildCiliumEgressManifest,
	perSandboxEgressLabelKey,
	verifyEgressPolicyApplied,
} from './egress-policy.js'
import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	KubernetesConflictError,
	KubernetesCredentialError,
} from './k8s-client.js'
import {
	type KubernetesOwnerReference,
	SANDBOX_API_GROUP,
	SANDBOX_API_VERSION,
	SANDBOX_EXTENSIONS_API_GROUP,
	ciliumNetworkPolicyCollectionPath,
	ciliumNetworkPolicyPath,
	validatingAdmissionPolicyBindingPath,
	validatingAdmissionPolicyPath,
} from './objects.js'

/**
 * Every per-sandbox policy's name starts with this, and the shipped admission
 * policy refuses one that does not.
 *
 * It is a CONSTANT rather than an option because it is half of a contract
 * with an object an operator applies: a configurable prefix would be a
 * configuration the fence could not know about, and a fence that trusted the
 * host to tell it what to allow would not be one.
 */
export const PER_SANDBOX_POLICY_NAME_PREFIX = 'namzu-sbx-'

/** `namzu-sbx-<uid>` — the only name this backend ever writes a policy under. */
export function perSandboxPolicyName(ownerUid: string): string {
	return `${PER_SANDBOX_POLICY_NAME_PREFIX}${ownerUid}`
}

/**
 * The object a per-sandbox policy belongs to: what the acquire created, which
 * is what the cluster deletes when the sandbox is destroyed.
 *
 * Two kinds, because this backend has two acquire paths and both must be able
 * to carry the capability: a `SandboxClaim` when the sandbox came out of a
 * warm pool, the `Sandbox` itself when it did not. The claim is the one the
 * issue names; the direct object works identically for garbage collection,
 * and refusing the pool-less path would be refusing it for a reason that is
 * about the pool rather than about the policy.
 */
export interface PerSandboxPolicyOwner {
	readonly kind: 'SandboxClaim' | 'Sandbox'
	readonly name: string
	/** `metadata.uid`, as the API server assigned it. Also the policy's name suffix. */
	readonly uid: string
}

/** The `ownerReferences` entry that makes the cluster collect the policy. */
export function perSandboxPolicyOwnerReference(
	owner: PerSandboxPolicyOwner,
): KubernetesOwnerReference {
	return {
		apiVersion: `${
			owner.kind === 'SandboxClaim' ? SANDBOX_EXTENSIONS_API_GROUP : SANDBOX_API_GROUP
		}/${SANDBOX_API_VERSION}`,
		kind: owner.kind,
		name: owner.name,
		uid: owner.uid,
	}
}

/**
 * Raised when the fence check is REFUSED rather than answered — a 401/403 on
 * one of the two cluster-scoped admission objects.
 *
 * Its own class rather than a reuse of
 * {@link KubernetesAdmissionFenceMissingError}, because the two ask for
 * different actions and conflating them would send an operator to apply a
 * fence that may already be there: 404 means the object does not exist, 403
 * means this host may not look. The most common cause is applying
 * `rbac-per-sandbox-egress.yaml`'s namespaced Role without the ClusterRole in
 * the same file, so the message names that file rather than the manifest the
 * missing-fence error names.
 */
export class KubernetesAdmissionFenceUnreadableError extends Error {
	override readonly name = 'KubernetesAdmissionFenceUnreadableError'

	constructor(
		readonly resourceKind: 'ValidatingAdmissionPolicy' | 'ValidatingAdmissionPolicyBinding',
		readonly objectName: string,
		readonly path: string,
		cause: unknown,
	) {
		super(
			`kubernetes: config.egress.perSandbox is configured but this host may not READ the ${resourceKind} named ${objectName} (${path}), so it cannot prove the fence that bounds what it writes. Both admission objects are cluster-scoped: the namespaced Role in k8s/manifests/rbac-per-sandbox-egress.yaml is not enough on its own, and the ClusterRole and ClusterRoleBinding in that same file are what grant the read. Nothing was written.`,
			{ cause },
		)
	}
}

/**
 * Raised when the admission fence is not in place — the policy, its binding,
 * or both — and therefore before anything has been written.
 *
 * Refusing rather than proceeding is the whole design: the fence is what
 * makes the write verbs safe to hold, so a deployment that granted them and
 * has not applied the fence is in exactly the state the capability exists to
 * avoid. A `ValidatingAdmissionPolicy` with no BINDING is inert — it validates
 * nothing at all — which is why the binding is checked separately rather than
 * assumed from the policy's existence.
 */
export class KubernetesAdmissionFenceMissingError extends Error {
	override readonly name = 'KubernetesAdmissionFenceMissingError'

	constructor(
		readonly resourceKind: 'ValidatingAdmissionPolicy' | 'ValidatingAdmissionPolicyBinding',
		readonly objectName: string,
		readonly path: string,
	) {
		super(
			`kubernetes: config.egress.perSandbox is configured but no ${resourceKind} named ${objectName} exists (${path}), so nothing would bound what this host writes to the namespace's CiliumNetworkPolicies. Apply k8s/manifests/validatingadmissionpolicy-cilium.yaml (and its binding) before calling setNetworkPolicy — the host holds create/patch/delete on every policy in the namespace, and the fence is what limits that to objects named ${PER_SANDBOX_POLICY_NAME_PREFIX}<owner uid>, selected by one label, carrying only toFQDNs and the cluster-DNS rule. Nothing was written.`,
		)
	}
}

/**
 * Raised for an `allowedHosts` entry this backend will not translate —
 * re-exported rather than defined here.
 *
 * It lives in `egress-policy.ts` beside {@link assertHostsFitNarrowing},
 * because the config-level `ciliumNarrowing` translation raises the same
 * class for the same entry, and this module imports that one: defining it
 * here would make the two modules import each other. The identifier is
 * re-exported so every existing import path — including the package index —
 * keeps resolving.
 */
export { KubernetesNetworkPolicyHostError }

/** A DNS name, lowercase, no scheme, no port, no wildcard. */
const DNS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/

/**
 * One `allowedHosts` entry, validated and canonicalised to the bytes a
 * `CiliumNetworkPolicy` should carry.
 *
 * Lowercasing is not leniency: DNS names are case-insensitive, so
 * `API.example.com` and `api.example.com` name the same host, and Cilium's
 * `matchName` is compared against what the DNS proxy saw — lowercase. The
 * docker backend accepts either case, and a list that worked there and threw
 * here would be a portability trap with no boundary behind it.
 */
function normalizeHost(entry: string): string {
	if (typeof entry !== 'string') {
		throw new KubernetesNetworkPolicyHostError(String(entry), 'is not a string')
	}
	const canonical = entry.toLowerCase()
	assertUsableHost(canonical)
	return canonical
}

function assertUsableHost(entry: string): void {
	if (typeof entry !== 'string' || entry === '') {
		throw new KubernetesNetworkPolicyHostError(String(entry), 'is empty')
	}
	const bare = entry.startsWith('.') ? entry.slice(1) : entry
	if (bare === '') {
		throw new KubernetesNetworkPolicyHostError(entry, 'names no domain after its leading dot')
	}
	if (entry.includes('*')) {
		throw new KubernetesNetworkPolicyHostError(
			entry,
			"contains a glob; a domain and its subdomains are written with a leading dot ('.example.com'), which becomes matchName plus matchPattern",
		)
	}
	if (!DNS_NAME.test(bare)) {
		throw new KubernetesNetworkPolicyHostError(
			entry,
			'is not a DNS name (a scheme, a path, a port suffix and an IP address all land here; letter case is canonicalised before this check, so it is never the cause)',
		)
	}
	if (bare.length > 253) {
		throw new KubernetesNetworkPolicyHostError(entry, 'is longer than a DNS name may be')
	}
	// A leading-dot entry becomes `matchPattern: '*.<domain>'`, and a
	// single-label domain there is a whole public suffix — `.com`, `.org`.
	// That is not an allowlist entry, and the shipped admission fence refuses
	// the pattern it would produce, so refusing it HERE is what turns an
	// opaque 403 from the API server into an error naming the entry.
	if (entry.startsWith('.') && !bare.includes('.')) {
		throw new KubernetesNetworkPolicyHostError(
			entry,
			"names a whole top-level domain ('.com' means every name under it); a domain entry needs at least two labels, as in '.example.com', and the shipped admission policy refuses the '*.com' pattern this would emit",
		)
	}
	// An IPv4 literal passes the grammar above — every label is digits, and
	// digits are legal in a DNS label. It is still not a hostname: a DNS
	// top-level label is never all-numeric, and Cilium's `matchName` is
	// compared against names the DNS proxy SAW, which an address never is. A
	// policy carrying one is admitted and matches nothing, which reads from
	// outside exactly like a policy that is working.
	const lastLabel = bare.slice(bare.lastIndexOf('.') + 1)
	if (/^[0-9]+$/.test(lastLabel)) {
		throw new KubernetesNetworkPolicyHostError(
			entry,
			'ends in an all-numeric label, so it is an address rather than a hostname; toFQDNs matches names a DNS lookup returned, and an address is never one of them (use config.egress.policy for address-based egress)',
		)
	}
}

/**
 * Raised when the object an acquire created reported no `metadata.uid`.
 *
 * Its own exported class rather than a bare `Error` because every other
 * refusal this capability adds is catchable by class, and this one refuses an
 * ACQUIRE: a caller that wants to fall back to a sandbox without per-sandbox
 * egress has to be able to tell it from a readiness timeout.
 */
export class KubernetesOwnerUidMissingError extends Error {
	override readonly name = 'KubernetesOwnerUidMissingError'

	constructor(
		readonly objectName: string,
		readonly namespace: string,
	) {
		super(
			`kubernetes: ${objectName} in namespace ${namespace} was created but reported no metadata.uid, in its create reply or in any readiness read. config.egress.perSandbox needs that uid: it is what a per-sandbox CiliumNetworkPolicy names in its ownerReferences (so the cluster deletes the policy with the object) and the suffix of the policy's own name. Refusing rather than handing back a sandbox whose setNetworkPolicy would write an orphan.`,
		)
	}
}

/**
 * The once-per-backend proof that the fence exists.
 *
 * Memoized on SUCCESS only, exactly as the egress named-object check is: a
 * transient API failure must not wedge every later `setNetworkPolicy` behind
 * a stale rejection, and an operator who applies the fence after the first
 * refusal gets the next call through without restarting the host.
 */
export interface PerSandboxPolicyFence {
	assertApplied(signal?: AbortSignal): Promise<void>
}

export function buildAdmissionFence(
	client: KubernetesClient,
	perSandbox: KubernetesPerSandboxEgressConfig,
): PerSandboxPolicyFence {
	const policyName = perSandbox.admissionPolicyName
	const bindingName = perSandbox.admissionPolicyBindingName ?? `${policyName}-binding`
	let applied: Promise<void> | undefined
	const read = async (
		kind: 'ValidatingAdmissionPolicy' | 'ValidatingAdmissionPolicyBinding',
		name: string,
		path: string,
		signal?: AbortSignal,
	): Promise<void> => {
		try {
			await client.request('GET', path, undefined, signal)
		} catch (err) {
			if (err instanceof KubernetesAlreadyGoneError) {
				throw new KubernetesAdmissionFenceMissingError(kind, name, path)
			}
			// A 401/403 is NOT "the fence is missing": the object may be there
			// and this host simply may not read it. Both refuse the write, and
			// they send an operator to different files.
			if (err instanceof KubernetesCredentialError) {
				throw new KubernetesAdmissionFenceUnreadableError(kind, name, path, err)
			}
			throw err
		}
	}
	return {
		async assertApplied(signal) {
			applied ??= (async () => {
				await read(
					'ValidatingAdmissionPolicy',
					policyName,
					validatingAdmissionPolicyPath(policyName),
					signal,
				)
				await read(
					'ValidatingAdmissionPolicyBinding',
					bindingName,
					validatingAdmissionPolicyBindingPath(bindingName),
					signal,
				)
			})().catch((err: unknown) => {
				applied = undefined
				throw err
			})
			await applied
		},
	}
}

/** What one sandbox's policy writer needs to know. */
export interface PerSandboxPolicySetterOptions {
	readonly client: KubernetesClient
	readonly fence: PerSandboxPolicyFence
	readonly namespace: string
	readonly egress: KubernetesEgressConfig & {
		readonly perSandbox: KubernetesPerSandboxEgressConfig
	}
	/** The object the acquire created, which owns the policy. */
	readonly owner: PerSandboxPolicyOwner
	/**
	 * The per-sandbox label's VALUE on this sandbox's pod — the name of the
	 * object above, put there by `composeAdditionalPodLabels` and CONFIRMED on
	 * the bound pod before the sandbox was admitted. The key comes from
	 * config, through the one resolver.
	 */
	readonly selectorValue: string
}

/**
 * Build the `setNetworkPolicy` this backend attaches to a sandbox handle.
 *
 * Calls are SERIALIZED per sandbox. Two overlapping calls would otherwise
 * interleave create, replace and read-back against one object, and the loser
 * would resolve having verified the winner's rules — a caller told its policy
 * was applied when a different one is in force is the exact failure the
 * read-back exists to prevent.
 */
export function buildPerSandboxPolicySetter(
	options: PerSandboxPolicySetterOptions,
): (policy: SandboxNetworkPolicy) => Promise<void> {
	const { client, fence, namespace, egress, owner, selectorValue } = options
	const perSandbox = egress.perSandbox
	const labelKey = perSandboxEgressLabelKey(egress)
	if (labelKey === undefined) {
		// Unreachable: the type above requires `perSandbox`, and the resolver
		// returns a key whenever it is present.
		throw new Error('kubernetes: per-sandbox egress is not configured')
	}
	const name = perSandboxPolicyName(owner.uid)
	const path = ciliumNetworkPolicyPath(namespace, name)
	let queue: Promise<void> = Promise.resolve()

	const translate = (allowedHosts: readonly string[]): KubernetesTranslatedEgressPolicy =>
		buildCiliumEgressManifest({
			namespace,
			name,
			selectorLabels: { [labelKey]: selectorValue },
			allowedHosts,
			// The CONFIGURED kind this stands in for: a host-supplied
			// allowlist is exactly what `'static'` means, and a refusal that
			// named anything else would send a reader to the wrong config key.
			policyKind: 'static',
			...(perSandbox.narrowing !== undefined ? { narrowing: perSandbox.narrowing } : {}),
			ownerReferences: [perSandboxPolicyOwnerReference(owner)],
			expandDomains: true,
		})

	const write = async (translated: KubernetesTranslatedEgressPolicy): Promise<void> => {
		const body = translated.manifest
		try {
			await client.request('POST', ciliumNetworkPolicyCollectionPath(namespace), body)
		} catch (err) {
			// The object already exists — this sandbox is narrowing its egress
			// a second time. A merge patch replaces `spec.egress` wholesale
			// (RFC 7386 replaces arrays), which is what a REPLACEMENT policy
			// needs, and the read-back below proves it rather than assuming it.
			if (!(err instanceof KubernetesConflictError)) throw err
			await client.request('PATCH', path, body)
		}
		// Resolve only once the cluster's own copy deep-equals the
		// translation, through the comparator the config-level check already
		// uses. A policy the API server accepted and mutated — a defaulting
		// webhook, an operator's own automation — would otherwise be reported
		// as the policy the caller asked for.
		//
		// One inherited wording to know about: if the object is GONE by the
		// time it is read back, the shared comparator raises
		// `KubernetesEgressPolicyNotAppliedError`, whose message asks an
		// operator to apply the manifest this backend computed. Here that is
		// not the action — the object was written a moment ago, so it being
		// gone means its owner was deleted underneath the call and this
		// sandbox is already being destroyed. The refusal is still right; only
		// its advice belongs to the other caller.
		await verifyEgressPolicyApplied(client, translated)
	}

	const remove = async (): Promise<void> => {
		try {
			await client.request('DELETE', path)
		} catch (err) {
			// Already gone is the state DELETE was asking for — the cluster
			// may have collected it with the claim while this call was in
			// flight.
			if (!(err instanceof KubernetesAlreadyGoneError)) throw err
		}
	}

	return async (policy: SandboxNetworkPolicy): Promise<void> => {
		// Validated BEFORE the queue, so a malformed list is refused with
		// nothing written and nothing waited for. `normalizeHost` also
		// lowercases: DNS names are case-insensitive, the docker backend
		// accepts either case, and a `CiliumNetworkPolicy` matches names the
		// resolver returns — which are lowercase. Refusing `API.example.com`
		// on one backend and honouring it on another would be a portability
		// trap, so it is canonicalised here instead.
		const hosts = [...(policy?.allowedHosts ?? [])].map(normalizeHost)
		// And refused here rather than emitted: an entry the CONFIGURED
		// narrowing cannot express is one whose policy would read as applied
		// and deny what it names. The shared guard refuses it again inside the
		// translation, so every caller is covered; this call is the earlier
		// one, before the fence is read and before anything is queued behind a
		// previous call.
		assertHostsFitNarrowing(
			hosts,
			perSandbox.narrowing,
			// The per-sandbox context, from `egress-policy.ts` rather than
			// rebuilt here: it is the SAME value `buildCiliumEgressManifest`
			// refuses by on this path (`expandDomains: true`), so the earlier
			// check and the translation's own cannot name different fields —
			// and the sentence it carries is the true one here, where the entry
			// really does become a name plus a `*.domain` pattern. The
			// config-level wording, where nothing is expanded, would be a lie
			// on this path: leaving the option off here does allow the domain
			// and its subdomains.
			PER_SANDBOX_NARROWING_REFUSAL,
		)
		// A previous call's failure belongs to that caller; this one still runs,
		// in order behind it.
		const run = queue.then(async () => {
			// Before EVERY write — the DELETE below included — and before
			// every one until the fence check succeeds: nothing is sent while
			// the fence is missing.
			//
			// The DELETE is checked too because the plan's invariant is about
			// writes, not about widening: a host that never proved the fence
			// must not reach the namespace's policies with any verb it holds.
			// The cost is a deployment that REMOVES the fence mid-run, whose
			// `setNetworkPolicy([])` is then refused and whose sandbox keeps
			// the wider per-sandbox allowance until it is destroyed and the
			// cluster collects the policy with its owner. That is a loud,
			// named refusal the caller can act on, which is the better half
			// of the trade against a silent unfenced write.
			await fence.assertApplied()
			// An EMPTY list is not "no policy": it deletes this sandbox's own
			// object and leaves the configured baseline — whatever
			// `config.egress.policy` translated to, plus every other policy
			// selecting the pod — in force.
			if (hosts.length === 0) {
				await remove()
				return
			}
			await write(translate(hosts))
		})
		queue = run.then(
			() => undefined,
			() => undefined,
		)
		await run
	}
}
