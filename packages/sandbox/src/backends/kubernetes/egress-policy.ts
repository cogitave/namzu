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
	SANDBOX_TEMPLATE_LABEL_KEY,
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
 * How {@link KubernetesCiliumEgressNarrowing.dnsNames} narrows the kube-dns
 * L7 rule. `true` uses every default below; an object customises them.
 *
 * The exact-name list a narrowed policy emits is, for each allowed host,
 * the bare name plus the host under `<namespace>.svc.<clusterDomain>`,
 * `svc.<clusterDomain>` and `<clusterDomain>` — because Cilium's `matchName`
 * is an EXACT name and does not match across a `.` the way `matchPattern`
 * does, and a search-list query for `github.com.svc.cluster.local` is a
 * DIFFERENT name than `github.com`. `searchSuffixes` adds more: kubelet
 * appends the node's own search domains, which this backend cannot see, so a
 * deployment whose nodes carry extra search domains lists them here or a
 * search-list query for one of them is refused by the DNS proxy — and, per
 * Cilium's own docs, some images (musl/Alpine) stop trying the search list
 * entirely the first time that happens, breaking the bare name lookup too.
 */
export interface KubernetesCiliumDnsNarrowing {
	/** Defaults to the egress target's own namespace (where the sandbox pods run). */
	readonly namespace?: string
	/** Defaults to `'cluster.local'`. */
	readonly clusterDomain?: string
	/** Appended after the three built-in suffixes, not replacing them. */
	readonly searchSuffixes?: readonly string[]
}

/**
 * Opt-in narrowing of a `static`/`resolver` hostname allowlist under
 * `engine: 'cilium'` — see the module doc and `#490`. Every field here is
 * OFF unless set, and setting none of them leaves the translation
 * byte-for-byte what it always emitted: that is the compatibility guarantee
 * a deployment with an already-applied policy relies on.
 *
 * Setting any field switches the translation from one shared `toFQDNs` rule
 * naming every host to one `toFQDNs` rule PER HOST, so ports and server
 * names can differ host by host. Refused synchronously (alongside
 * {@link assertEgressPolicyIsEnforceable}'s existing refusals) unless
 * `engine` is `'cilium'` and `policy.kind` is `'static'` or `'resolver'`.
 */
export interface KubernetesCiliumEgressNarrowing {
	/**
	 * TCP ports allowed to every host that has no entry in `hostPorts`, e.g.
	 * `[443]`. Leaving both this and `hostPorts` unset — with `dnsNames` and
	 * `tlsServerNames` also unset — means no port narrowing: a host's
	 * `toFQDNs` rule carries no `toPorts` at all, exactly as the
	 * unnarrowed translation emits today (every port reachable).
	 */
	readonly ports?: readonly number[]
	/**
	 * Per-host TCP port overrides, keyed by the host exactly as it appears in
	 * `allowedHosts` or a `resolver`'s result. A host with no entry here
	 * falls back to `ports`.
	 */
	readonly hostPorts?: Readonly<Record<string, readonly number[]>>
	/**
	 * Narrow the kube-dns L7 rule from `rules.dns: [{ matchPattern: '*' }]`
	 * to an exact `matchName` per allowed host, and per host-plus-suffix. See
	 * {@link KubernetesCiliumDnsNarrowing}.
	 */
	readonly dnsNames?: boolean | KubernetesCiliumDnsNarrowing
	/**
	 * Add `serverNames: [<host>]` to each host's TLS ports (SNI enforcement,
	 * which needs Cilium's L7 proxy — see the module doc). A host with no
	 * port configured in `ports`/`hostPorts` is limited to `tlsPorts` rather
	 * than left with no port restriction at all, because a `serverNames`
	 * rule needs a port to attach to.
	 */
	readonly tlsServerNames?: boolean
	/**
	 * Which of a host's configured ports are TLS ports, for
	 * `tlsServerNames`: those get `serverNames` on their own `toPorts`
	 * entry, the rest (if any) get a separate entry with none. Defaults to
	 * `[443]`. Meaningless unless `tlsServerNames` is set.
	 */
	readonly tlsPorts?: readonly number[]
}

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
	/**
	 * Opt-in port/DNS-name/TLS-server-name narrowing for a `static`/
	 * `resolver` allowlist under `engine: 'cilium'`. Unset (the default)
	 * emits exactly what every release before this one did. See
	 * {@link KubernetesCiliumEgressNarrowing}.
	 */
	readonly ciliumNarrowing?: KubernetesCiliumEgressNarrowing
	/**
	 * Which egress PROFILE the sandboxes this backend produces run under —
	 * a DNS-1123 label value such as `none` or `internet`.
	 *
	 * Unset (the default) is the single-profile world this backend has
	 * always had: one policy per backend, selected by the template label
	 * alone, and every emitted body, selector and policy name byte-identical
	 * to the release before profiles existed.
	 *
	 * SET, it becomes a pod LABEL — {@link profileLabelKey} is its key —
	 * which travels three places at once: onto the `SandboxClaim`'s
	 * `additionalPodMetadata.labels`, onto a directly created Sandbox's pod
	 * template, and into the translated policy's own selector. That is what
	 * lets ONE warm pool serve several network modes: a claim carrying a
	 * profile label adopts a warm replica and the controller patches the
	 * label onto the running pod, with no cold start and no second pool —
	 * measured on agent-sandbox v1.0.2 (two profiles out of one two-replica
	 * pool, every adopt under 70 ms, each bound pod a replica that already
	 * existed). A label is the only claim-time metadata that is warm-safe:
	 * `env` and `volumeClaimTemplates` force a cold start, which is why
	 * neither appears on the claim body.
	 *
	 * OPERATOR PREREQUISITE, and it is not optional: the controller refuses
	 * a claim whose label key sits outside its `allowed-label-domains`
	 * allowlist (the `agent-sandbox-config` ConfigMap in the controller's
	 * namespace; default `sandbox.users.io`), so the DEFAULT key below is
	 * refused by a stock controller until an operator adds
	 * `sandbox.namzu.ai` to that key — or sets {@link profileLabelKey} to
	 * something already allowed. That refusal is fast and carries the
	 * controller's own reason and message: it is the acquire's ordinary
	 * `claim-rejected` failure, with a
	 * {@link KubernetesPodLabelsRejectedError} as its cause naming the labels
	 * that were sent and the key that moves them.
	 */
	readonly profile?: string
	/**
	 * Label key {@link profile} is written under. Defaults to
	 * {@link DEFAULT_EGRESS_PROFILE_LABEL_KEY}.
	 *
	 * Worth setting to `sandbox.users.io/egress-profile` on a cluster whose
	 * controller still carries the stock `allowed-label-domains` — that
	 * domain is upstream's own default and needs no ConfigMap edit at all.
	 */
	readonly profileLabelKey?: string
}

/**
 * Default {@link KubernetesEgressConfig.profileLabelKey} — this backend's
 * own label domain, matching `SANDBOX_TEMPLATE_LABEL_KEY`'s prefix so
 * every label a namzu host puts on a sandbox pod reads as one family.
 *
 * It is deliberately NOT upstream's `sandbox.users.io`: a key in someone
 * else's domain is a key someone else may define differently. The cost is
 * the ConfigMap edit named on {@link KubernetesEgressConfig.profile}, and
 * the controller's refusal spells that edit out itself.
 */
export const DEFAULT_EGRESS_PROFILE_LABEL_KEY = 'sandbox.namzu.ai/egress-profile'

/** One resolved profile label: the key it is written under and its value. */
export interface EgressProfileLabel {
	readonly key: string
	readonly value: string
}

/**
 * Kubernetes' own label-value grammar, narrowed to DNS-1123: lowercase
 * alphanumerics and `-`, starting and ending alphanumeric, at most 63
 * characters.
 *
 * Narrower than what a label value may legally hold (`_` and `.` are legal
 * there, and uppercase is too) because the profile is also a NAME: it goes
 * into `${template}-${profile}-egress`, which has to be a legal object name,
 * and a value that is legal as a label but not as a name would produce a
 * policy an operator cannot apply.
 */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/**
 * A label KEY: an optional DNS-subdomain prefix, a `/`, then a name segment
 * of at most 63 characters. Exactly what the API server enforces, checked
 * here so a typo is refused during host wiring rather than as a claim the
 * controller rejects one round trip later.
 */
const LABEL_KEY_NAME = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/
const LABEL_KEY_PREFIX = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/

/**
 * Named refusal for an egress PROFILE this backend can read but not use.
 * Sibling of {@link KubernetesEgressPolicyConfigError} rather than a reuse of
 * it: that one names a field under `config.egress.policy` and this one names
 * a field beside it, and an operator reading either should not have to work
 * out which level of the config the path belongs to.
 *
 * Thrown SYNCHRONOUSLY from `buildKubernetesBackend` and
 * `createKubernetesWorkspace`, so a misconfigured profile surfaces during
 * host wiring rather than on the first `create()`.
 */
export class KubernetesEgressProfileConfigError extends Error {
	override readonly name = 'KubernetesEgressProfileConfigError'

	constructor(
		readonly field: 'profile' | 'profileLabelKey',
		readonly value: string,
		reason: string,
	) {
		super(
			`kubernetes: config.egress.${field} is unusable: ${JSON.stringify(value)} ${reason}. The profile travels onto a SandboxClaim's additionalPodMetadata.labels, onto a directly created Sandbox's pod template and into the translated policy's own selector, so a value the API server would reject leaves either a claim nothing binds or a policy nobody can apply. Refusing here rather than emitting it.`,
		)
	}
}

/**
 * The profile label this config asks for, or nothing at all — the ONE place
 * the key/value pair is derived, so the claim body, the Sandbox pod
 * template, the policy selector and the policy name cannot disagree about
 * what the profile is.
 *
 * Validates as it resolves: the value has to be a DNS-1123 label and the key
 * a legal label key, both refused with {@link KubernetesEgressProfileConfigError}.
 */
export function egressProfileLabel(
	egress: KubernetesEgressConfig | undefined,
): EgressProfileLabel | undefined {
	// The KEY is validated whenever it is present, profile or no profile. A
	// key set without a value is a half-finished configuration — the value is
	// usually the next line someone writes — and reporting the typo only once
	// the profile arrives is reporting it at the second edit rather than the
	// first.
	const configured = egress?.profileLabelKey
	if (configured !== undefined) assertUsableProfileLabelKey(configured)
	const value = egress?.profile
	if (value === undefined) return undefined
	if (!DNS_1123_LABEL.test(value)) {
		throw new KubernetesEgressProfileConfigError(
			'profile',
			value,
			'is not a DNS-1123 label (lowercase letters, digits and dashes, starting and ending alphanumeric, at most 63 characters)',
		)
	}
	const key = configured ?? DEFAULT_EGRESS_PROFILE_LABEL_KEY
	return { key, value }
}

/**
 * Refuse a `profileLabelKey` the API server would not take, or that this
 * backend already uses for something else.
 */
function assertUsableProfileLabelKey(key: string): void {
	const slash = key.indexOf('/')
	const name = slash === -1 ? key : key.slice(slash + 1)
	const prefix = slash === -1 ? undefined : key.slice(0, slash)
	if (
		!LABEL_KEY_NAME.test(name) ||
		(prefix !== undefined && !LABEL_KEY_PREFIX.test(prefix)) ||
		key.indexOf('/', slash + 1) !== -1
	) {
		throw new KubernetesEgressProfileConfigError(
			'profileLabelKey',
			key,
			'is not a Kubernetes label key (an optional DNS-subdomain prefix, a single slash, then a name of at most 63 characters)',
		)
	}
	// The one legal key that must not be used: it is the key this backend
	// stamps the SandboxTemplate name under, and the profile label is applied
	// LAST (see `sandboxPodLabels`), so this key would overwrite the template
	// label on every pod this backend creates — and the translated policy's
	// selector, built from the same resolution, would agree with it. Both
	// halves would be wrong together, which is exactly the shape nothing else
	// would catch.
	if (key === SANDBOX_TEMPLATE_LABEL_KEY) {
		throw new KubernetesEgressProfileConfigError(
			'profileLabelKey',
			key,
			'is the key this backend writes the SandboxTemplate name under, and a profile label is applied last — a pod would carry the profile value where its template label belongs, and the policy selector built from the same resolution would match it anyway',
		)
	}
}

/**
 * Validate the profile without needing its value — the wiring-time hook, so
 * `buildKubernetesBackend` and `createKubernetesWorkspace` refuse a bad
 * profile the same moment they refuse an unenforceable policy.
 */
export function assertEgressProfileIsUsable(egress: KubernetesEgressConfig | undefined): void {
	egressProfileLabel(egress)
}

/**
 * The ONE composer for a sandbox pod's `additionalPodMetadata.labels`.
 *
 * Every label this backend asks the controller to put on a POD is built
 * here: the egress profile today, and whatever a later capability
 * contributes through `extra` (a per-sandbox policy selector, for one). Two
 * independent constructions would be two answers to "what labels is this pod
 * selected by", and the policy selector is built from the same resolution —
 * so a second builder would be a pod bound under a policy nobody checked.
 *
 * Deliberately NOT where `KubernetesBackendInternalConfig.claimLabels`
 * goes. Those are a host's own bookkeeping on the CLAIM object's
 * `metadata.labels`; putting them on the pod would change what selectors
 * match a running sandbox, which is a different question on a different
 * object.
 *
 * Returns an empty object when nothing applies, which every caller reads as
 * "emit nothing at all" — that is what keeps an unprofiled body byte-identical.
 *
 * A key in `extra` that is ALSO the profile's is refused rather than merged
 * either way round. Whichever won, the loser would be a label the translated
 * policy's selector still expects: the profile's selector is built from this
 * same resolution, so a pod carrying the other value is selected by no
 * per-profile policy while `create()` reported the boundary verified. It is
 * the same failure {@link egressProfileLabel} refuses the template key for,
 * reached from the other direction.
 */
export function composeAdditionalPodLabels(
	egress: KubernetesEgressConfig | undefined,
	extra?: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const profile = egressProfileLabel(egress)
	if (profile !== undefined && extra !== undefined && profile.key in extra) {
		throw new KubernetesEgressProfileConfigError(
			'profileLabelKey',
			profile.key,
			`is also the key another capability contributes to the same pod-label map (as ${JSON.stringify(extra[profile.key])}), and one of the two values would silently replace the other`,
		)
	}
	return {
		...(profile !== undefined ? { [profile.key]: profile.value } : {}),
		...extra,
	}
}

/**
 * Why a claim the controller refused with `InvalidMetadata` was refused, in
 * this backend's own terms — in practice a pod label whose domain is not in
 * the controller's `allowed-label-domains` allowlist, which today means the
 * egress profile's.
 *
 * NOT what an acquire throws. A refused claim comes out of `create()` as
 * `KubernetesAcquireError { reason: 'claim-rejected' }` whether or not a
 * profile is configured — one condition, one taxonomy, one `catch` — and this
 * rides as that error's `cause`. Two classes for one controller condition
 * would make a host's error handling correct or incorrect depending on
 * whether `config.egress.profile` happened to be set.
 *
 * What it adds to the acquire error is what the controller cannot know: the
 * map this backend actually sent, and the `config.egress.profileLabelKey`
 * that moves the offending key to an allowed domain. It carries the whole map
 * rather than the profile alone, and `profile` is optional, because the map is
 * {@link composeAdditionalPodLabels}'s — the profile is the only thing in it
 * today, and a later capability adding a second key would otherwise get an
 * explanation that named a label it did not send.
 *
 * It carries the controller's OWN `reason` and `message` rather than a
 * translation of them: the message agent-sandbox v1.0.2 writes names the
 * offending key, the domain, the ConfigMap key to edit and its default, and
 * no paraphrase of it would be as useful. Measured verbatim against a kind
 * cluster running that controller:
 *
 * > invalid additionalPodMetadata: failed to validate label
 * > "sandbox.namzu.ai/egress-profile": label domain "sandbox.namzu.ai" is
 * > not in the allowlist (configure the allowed-label-domains key of the
 * > agent-sandbox-config ConfigMap in the controller namespace; default:
 * > sandbox.users.io)
 *
 * The refusal is raised as soon as that condition is read rather than after
 * the readiness budget, because `InvalidMetadata` is one of
 * `TERMINAL_CLAIM_REASONS` — nothing about it becomes true by waiting — and
 * the claim is deleted on the way out, so a misconfigured profile costs one
 * round trip rather than a minute of polling.
 */
export class KubernetesPodLabelsRejectedError extends Error {
	override readonly name = 'KubernetesPodLabelsRejectedError'

	constructor(
		/** Every label this backend put on the claim's `additionalPodMetadata`. */
		readonly requestedPodLabels: Readonly<Record<string, string>>,
		readonly claimName: string,
		readonly namespace: string,
		/** The controller's own condition `reason`, e.g. `InvalidMetadata`. */
		readonly controllerReason: string,
		/** The controller's own condition `message`, verbatim. */
		readonly controllerMessage: string,
		/** The egress profile among those labels, when one is configured. */
		readonly profile?: EgressProfileLabel,
	) {
		super(
			`kubernetes: the controller refused SandboxClaim ${claimName} in namespace ${namespace} carrying the pod labels ${formatLabels(requestedPodLabels)} — ${controllerReason}: ${controllerMessage}. Those labels are written onto the claim's additionalPodMetadata.labels, so each key's domain has to appear in the controller's allowed-label-domains allowlist; add it there, or move the offending key to a domain that is already allowed${profile === undefined ? '' : ` (config.egress.profileLabelKey, for the egress profile ${profile.key}=${profile.value})`}. The claim has been deleted.`,
		)
	}
}

/**
 * Named refusal for a bound pod that never carried a label this backend asked
 * the controller to put on it — the egress profile's, today the only one
 * {@link composeAdditionalPodLabels} produces, which is why the class is named
 * for the LABEL rather than for the profile.
 *
 * This is the one failure this capability must not have quietly. An
 * unlabelled pod handed back is a sandbox running under the DEFAULT policy
 * while the host believes it is on a narrower profile — the translated
 * policy's selector includes the profile label, so a pod without it is
 * selected by neither this profile's policy nor, necessarily, anything else.
 * Refusing is correct and waiting is correct; proceeding is not, so the
 * acquire releases what it claimed and raises this instead.
 *
 * `missingLabel` is the pair that never arrived rather than "the profile", so
 * the refusal stays true for whatever a later capability contributes to that
 * same map: the wait in `readAddressedPod` already covers every entry of it,
 * and this refusal covers exactly the same set.
 */
export class KubernetesPodLabelNotObservedError extends Error {
	override readonly name = 'KubernetesPodLabelNotObservedError'

	constructor(
		/** The label this backend requested and never saw on the bound pod. */
		readonly missingLabel: EgressProfileLabel,
		readonly subject: string,
		readonly observedLabels: Readonly<Record<string, string>>,
	) {
		super(
			`kubernetes: refusing ${subject} — its pod never carried the label ${missingLabel.key}=${missingLabel.value} this backend asked the controller to put on it, within the readiness budget; the labels it did carry are ${formatLabels(observedLabels)}. The translated policy's selector includes that label, so admitting this pod would run it under whatever policy DOES select it rather than under the configured profile. The controller patches a claim's additionalPodMetadata.labels onto the pod it binds — a pod that never got them means the claim's metadata was not applied. Nothing was handed back and the claim was released.`,
		)
	}
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
	/**
	 * The egress PROFILE label this policy also selects, when
	 * {@link KubernetesEgressConfig.profile} is set. Absent, the selector is
	 * the template label alone and every translation is what it always was.
	 *
	 * It is part of the SELECTOR rather than a second policy because that is
	 * what makes one warm pool serve several modes: pods out of one template
	 * carry one template label and differ only by this one, so
	 * `${template}-none-egress` selects exactly the `none` pods and
	 * `${template}-internet-egress` exactly the `internet` ones.
	 */
	readonly profile?: EgressProfileLabel
}

/**
 * What a translated policy's `podSelector`/`endpointSelector` matches: the
 * template label, plus the profile label when one is configured. One
 * function so the two manifest builders below and every reader of a
 * translation agree on the selector down to the key order.
 */
export function egressPolicySelectorLabels(
	target: EgressPolicyTarget,
): Readonly<Record<string, string>> {
	return {
		...sandboxTemplateLabel(target.sandboxTemplateName),
		...(target.profile !== undefined ? { [target.profile.key]: target.profile.value } : {}),
	}
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

/**
 * The longest name a Kubernetes object may carry. A `NetworkPolicy` name is a
 * DNS subdomain, so 253 characters, and the API server refuses anything
 * longer.
 */
const MAX_OBJECT_NAME_LENGTH = 253

/**
 * `${sandboxTemplateName}-egress`, the name
 * {@link KubernetesEgressConfig.networkPolicyName} defaults to — or
 * `${sandboxTemplateName}-${profile}-egress` when a profile is configured,
 * because one template under two profiles needs two policy objects and a
 * single default name would have the second silently verify against the
 * first's manifest.
 *
 * The profile is bounded at 63 characters on its own, but the CONCATENATION
 * is what has to be a legal object name, and only this function knows both
 * halves. Refused here, during host wiring, rather than as an API-server
 * rejection on the first policy GET of the first `create()`: `networkPolicyName`
 * is the way out and it is a config field, so this is a config error.
 */
export function defaultEgressPolicyName(sandboxTemplateName: string, profile?: string): string {
	if (profile === undefined) return `${sandboxTemplateName}-egress`
	const name = `${sandboxTemplateName}-${profile}-egress`
	if (name.length > MAX_OBJECT_NAME_LENGTH) {
		throw new KubernetesEgressProfileConfigError(
			'profile',
			profile,
			`makes the default egress policy name ${JSON.stringify(name)} ${name.length} characters long, past the ${MAX_OBJECT_NAME_LENGTH} an object name may carry — shorten the profile or the SandboxTemplate name, or set config.egress.networkPolicyName yourself`,
		)
	}
	return name
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
 * Named refusal for `config.egress.ciliumNarrowing` set on a policy/engine
 * combination it does not apply to. Thrown SYNCHRONOUSLY from
 * {@link assertEgressPolicyIsEnforceable}, beside
 * {@link KubernetesUnenforceableEgressPolicyError}, so a narrowing option
 * that would silently do nothing is refused at host-wiring time rather than
 * accepted and ignored.
 */
export class KubernetesEgressNarrowingUnsupportedError extends Error {
	override readonly name = 'KubernetesEgressNarrowingUnsupportedError'

	constructor(
		readonly policyKind: KubernetesEgressPolicy['kind'],
		readonly engine: KubernetesEgressEngine,
	) {
		super(
			`kubernetes: config.egress.ciliumNarrowing is set, but config.egress.policy is '${policyKind}' under engine ${JSON.stringify(engine)}. Port, DNS-name and TLS-server-name narrowing only apply to a 'static' or 'resolver' hostname allowlist under engine: 'cilium' — set engine: 'cilium' with one of those policy kinds, or remove ciliumNarrowing. Refusing rather than silently ignoring an option that would never be applied.`,
		)
	}
}

/**
 * Every entry in `narrowing.ports`, `narrowing.hostPorts` and
 * `narrowing.tlsPorts` is a port the API server will actually accept, none of
 * those three is an explicitly empty array, and every DNS suffix
 * `narrowing.dnsNames` names is a non-empty string — checked here,
 * synchronously, for the same reason {@link assertEgressPolicyIsEnforceable}
 * checks `exceptCidrs`: a value the API server rejects on apply would leave a
 * policy that never verifies.
 */
function assertNarrowingIsUsable(narrowing: KubernetesCiliumEgressNarrowing): void {
	const assertValidPort = (port: unknown, field: string): void => {
		if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
			throw new KubernetesEgressPolicyConfigError(
				field,
				`${JSON.stringify(port)} is not a TCP port a NetworkPolicy/CiliumNetworkPolicy can carry (an integer 1-65535)`,
			)
		}
	}
	// `undefined` means "no restriction on this list" and is fine; `[]` is
	// neither that nor a usable restriction — `narrowedHostFqdnRule` would
	// emit `toPorts: [{ ports: [] }]` for it, a shape the API server rejects
	// on apply. Refuse it here rather than let a typo (`ports: []` where
	// `ports` was meant to be omitted) reach the cluster as a policy that
	// never verifies.
	const assertNotEmptyPortList = (ports: readonly number[] | undefined, field: string): void => {
		if (ports !== undefined && ports.length === 0) {
			throw new KubernetesEgressPolicyConfigError(
				field,
				'must not be an empty array — omit the field entirely for no port restriction, or list at least one port',
			)
		}
	}
	assertNotEmptyPortList(narrowing.ports, 'ciliumNarrowing.ports')
	for (const port of narrowing.ports ?? []) assertValidPort(port, 'ciliumNarrowing.ports')
	for (const [host, ports] of Object.entries(narrowing.hostPorts ?? {})) {
		assertNotEmptyPortList(ports, `ciliumNarrowing.hostPorts[${JSON.stringify(host)}]`)
		for (const port of ports) {
			assertValidPort(port, `ciliumNarrowing.hostPorts[${JSON.stringify(host)}]`)
		}
	}
	assertNotEmptyPortList(narrowing.tlsPorts, 'ciliumNarrowing.tlsPorts')
	for (const port of narrowing.tlsPorts ?? []) assertValidPort(port, 'ciliumNarrowing.tlsPorts')
	if (typeof narrowing.dnsNames === 'object') {
		const { clusterDomain, searchSuffixes } = narrowing.dnsNames
		if (clusterDomain !== undefined && clusterDomain.trim() === '') {
			throw new KubernetesEgressPolicyConfigError(
				'ciliumNarrowing.dnsNames.clusterDomain',
				'must not be an empty string',
			)
		}
		for (const suffix of searchSuffixes ?? []) {
			if (typeof suffix !== 'string' || suffix.trim() === '') {
				throw new KubernetesEgressPolicyConfigError(
					'ciliumNarrowing.dnsNames.searchSuffixes',
					`${JSON.stringify(suffix)} is not a usable DNS suffix`,
				)
			}
		}
	}
}

/** Does `narrowing` actually ask for anything, or is every field off/absent. */
function ciliumNarrowingIsActive(
	narrowing: KubernetesCiliumEgressNarrowing | undefined,
): narrowing is KubernetesCiliumEgressNarrowing {
	if (narrowing === undefined) return false
	if (narrowing.ports !== undefined) return true
	if (narrowing.hostPorts !== undefined && Object.keys(narrowing.hostPorts).length > 0) return true
	if (dnsNarrowingIsActive(narrowing.dnsNames)) return true
	if (narrowing.tlsServerNames === true) return true
	return false
}

function dnsNarrowingIsActive(dnsNames: KubernetesCiliumEgressNarrowing['dnsNames']): boolean {
	return activeDnsNarrowing(dnsNames) !== undefined
}

/** `dnsNames` reduced to the config it names, or `undefined` when it is off. `true` reduces to every default. */
function activeDnsNarrowing(
	dnsNames: KubernetesCiliumEgressNarrowing['dnsNames'],
): KubernetesCiliumDnsNarrowing | undefined {
	if (dnsNames === true) return {}
	if (typeof dnsNames === 'object' && dnsNames !== null) return dnsNames
	return undefined
}

/**
 * Synchronous, no-I/O precondition: can `policy.kind` be enforced under
 * `engine` at all, and — if `narrowing` is set — does it apply to this
 * policy/engine combination. Deliberately decided from the KIND alone — a
 * `resolver` policy's `resolve()` is never invoked here, both because calling
 * it just to prove a refusal would be wasted work (and possibly a side effect
 * the host did not expect yet) and because this has to stay callable
 * synchronously from `buildKubernetesBackend`, which contacts nothing.
 */
export function assertEgressPolicyIsEnforceable(
	policy: KubernetesEgressPolicy,
	engine: KubernetesEgressEngine,
	narrowing?: KubernetesCiliumEgressNarrowing,
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
	if (ciliumNarrowingIsActive(narrowing)) {
		if (engine !== 'cilium' || (policy.kind !== 'static' && policy.kind !== 'resolver')) {
			throw new KubernetesEgressNarrowingUnsupportedError(policy.kind, engine)
		}
		assertNarrowingIsUsable(narrowing)
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
					matchLabels: egressPolicySelectorLabels(target),
				},
				policyTypes: ['Egress'],
				egress,
			},
		},
	}
}

/** `[443]` — the TLS-port default for both `tlsServerNames` and `tlsPorts`. */
const DEFAULT_TLS_PORTS = [443] as const

/** `{ port: '443', protocol: 'TCP' }` — Cilium's port shape, ports spelled as strings. */
function ciliumPortEntry(port: number): Readonly<Record<string, unknown>> {
	return { port: String(port), protocol: 'TCP' }
}

/**
 * The port list a narrowed translation applies to `host`, before splitting
 * out the TLS subset — see {@link KubernetesCiliumEgressNarrowing.ports}.
 * `undefined` means no port restriction: the host's `toFQDNs` rule carries
 * no `toPorts` at all.
 */
function narrowedHostPorts(
	host: string,
	narrowing: KubernetesCiliumEgressNarrowing,
): readonly number[] | undefined {
	const explicit = narrowing.hostPorts?.[host] ?? narrowing.ports
	if (explicit !== undefined) return explicit
	// `serverNames` needs a port to attach to — leaving this host with no
	// port at all would mean either no `serverNames` rule (silently dropping
	// the option) or one with no `toPorts`, which Cilium rejects on apply.
	if (narrowing.tlsServerNames === true) return narrowing.tlsPorts ?? DEFAULT_TLS_PORTS
	return undefined
}

/**
 * One host's `toFQDNs` rule under narrowing: the bare allowlist entry, plus
 * `toPorts` split into a `serverNames`-bearing entry for the host's TLS
 * ports and a plain entry for whatever is left, when `tlsServerNames` is on.
 */
function narrowedHostFqdnRule(
	host: string,
	narrowing: KubernetesCiliumEgressNarrowing,
): Readonly<Record<string, unknown>> {
	const ports = narrowedHostPorts(host, narrowing)
	if (ports === undefined) return { toFQDNs: [{ matchName: host }] }
	if (narrowing.tlsServerNames !== true) {
		return { toFQDNs: [{ matchName: host }], toPorts: [{ ports: ports.map(ciliumPortEntry) }] }
	}
	const tlsPorts = narrowing.tlsPorts ?? DEFAULT_TLS_PORTS
	const tlsSubset = ports.filter((port) => tlsPorts.includes(port))
	const rest = ports.filter((port) => !tlsPorts.includes(port))
	const toPorts: Record<string, unknown>[] = []
	if (tlsSubset.length > 0) {
		toPorts.push({ ports: tlsSubset.map(ciliumPortEntry), serverNames: [host] })
	}
	if (rest.length > 0) toPorts.push({ ports: rest.map(ciliumPortEntry) })
	return {
		toFQDNs: [{ matchName: host }],
		...(toPorts.length > 0 ? { toPorts } : {}),
	}
}

/**
 * The DNS-visibility rule narrowed to an exact `matchName` per allowed host
 * plus the host under every search suffix, replacing
 * {@link CILIUM_DNS_VISIBILITY_RULE}'s `matchPattern: '*'`. See
 * {@link KubernetesCiliumDnsNarrowing}.
 */
function narrowedDnsVisibilityRule(
	allowedHosts: readonly string[],
	fallbackNamespace: string,
	dnsNames: KubernetesCiliumDnsNarrowing,
): Readonly<Record<string, unknown>> {
	const namespace = dnsNames.namespace ?? fallbackNamespace
	const clusterDomain = dnsNames.clusterDomain ?? 'cluster.local'
	const suffixes = [
		`${namespace}.svc.${clusterDomain}`,
		`svc.${clusterDomain}`,
		clusterDomain,
		...(dnsNames.searchSuffixes ?? []),
	]
	const matchNames: { matchName: string }[] = []
	for (const host of allowedHosts) {
		matchNames.push({ matchName: host })
		for (const suffix of suffixes) matchNames.push({ matchName: `${host}.${suffix}` })
	}
	return {
		toEndpoints: CILIUM_DNS_VISIBILITY_RULE.toEndpoints,
		toPorts: [
			{
				ports: [{ port: '53', protocol: 'ANY' }],
				rules: { dns: matchNames },
			},
		],
	}
}

function buildCiliumNetworkPolicy(
	target: EgressPolicyTarget,
	policyKind: KubernetesEgressPolicy['kind'],
	allowedHosts: readonly string[],
	narrowing: KubernetesCiliumEgressNarrowing | undefined,
): KubernetesTranslatedEgressPolicy {
	// Unnarrowed is the exact shape every release before #490 emitted — kept
	// as its own branch, untouched, rather than folded into the narrowed one
	// with every option defaulted off, so the byte-identical guarantee does
	// not depend on the narrowed code path happening to reduce to it.
	const activeDns = ciliumNarrowingIsActive(narrowing)
		? activeDnsNarrowing(narrowing.dnsNames)
		: undefined
	const dnsRule =
		activeDns !== undefined
			? narrowedDnsVisibilityRule(allowedHosts, target.namespace, activeDns)
			: CILIUM_DNS_VISIBILITY_RULE
	const hostRules = ciliumNarrowingIsActive(narrowing)
		? allowedHosts.map((host) => narrowedHostFqdnRule(host, narrowing))
		: [{ toFQDNs: allowedHosts.map((host) => ({ matchName: host })) }]

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
					matchLabels: egressPolicySelectorLabels(target),
				},
				egress: [dnsRule, ...hostRules],
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
	ciliumNarrowing?: KubernetesCiliumEgressNarrowing,
): Promise<KubernetesTranslatedEgressPolicy> {
	assertEgressPolicyIsEnforceable(policy, engine, ciliumNarrowing)

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
			return buildCiliumNetworkPolicy(target, 'static', policy.allowedHosts, ciliumNarrowing)
		case 'resolver': {
			const allowedHosts = await policy.resolve()
			return buildCiliumNetworkPolicy(target, 'resolver', allowedHosts, ciliumNarrowing)
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

/** One `toFQDNs` entry the translation allows, with the ports it allows it on. */
interface AllowedFqdn {
	readonly host: string
	readonly ports: 'all' | readonly PortRange[]
}

/**
 * The cluster resolver's identity as a `PolicyPeer` — shared by
 * {@link egressAllowance} (reading a Cilium DNS-visibility rule into its
 * core-shaped equivalent) and {@link reachesResolverAtDnsPort} (deciding
 * whether some OTHER policy's rule reaches it), so there is one definition of
 * "this peer is the cluster resolver" rather than two that could drift apart.
 */
const RESOLVER_PEER: PolicyPeer = {
	kind: 'selector',
	namespaceSelector: {
		matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' },
	},
	podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } },
	text: 'the cluster resolver',
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
	/**
	 * `toFQDNs` names a `static`/`resolver` translation allows, each with the
	 * ports it allows that name on (`'all'` for the unnarrowed shape, which
	 * puts no `toPorts` on its `toFQDNs` rule at all). Empty for every core
	 * kind. A name can appear more than once — one entry per `toFQDNs` rule
	 * naming it — and it is allowed on a port if ANY entry covers that port,
	 * the same "any matching destination" rule {@link destinationIsAllowed}
	 * applies to CIDR and selector peers.
	 */
	readonly fqdns: readonly AllowedFqdn[]
	/**
	 * The exact DNS names a `static`/`resolver` translation's kube-dns rule
	 * restricts LOOKUPS to when `ciliumNarrowing.dnsNames` is set — the
	 * `matchName` list {@link narrowedDnsVisibilityRule} builds. `'all'` for
	 * every translation that does not narrow DNS: every core kind (which
	 * cannot express an L7 DNS restriction at all) and an unnarrowed
	 * `static`/`resolver` (`rules.dns: [{ matchPattern: '*' }]`).
	 *
	 * `destinations` alone cannot carry this: reachability to the resolver's
	 * peer and port is the same whether or not DNS is narrowed, so a peer/port
	 * check reports a plain kube-dns rule as `within` a narrowed translation
	 * exactly as it would an unnarrowed one. {@link reachesResolverAtDnsPort}
	 * is the check that actually reads this field, in both
	 * {@link coreEgressRuleVerdict} and {@link ciliumEgressRuleVerdict}.
	 */
	readonly dnsNarrowedTo: 'all' | readonly string[]
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
		const fqdns: AllowedFqdn[] = []
		// The DNS-visibility rule is the one entry among `rules` whose
		// `toEndpoints` names the cluster resolver — narrowed or not, it always
		// reuses `CILIUM_DNS_VISIBILITY_RULE.toEndpoints` verbatim (see
		// `narrowedDnsVisibilityRule` and `buildCiliumNetworkPolicy`), so a deep
		// equality check finds it regardless of which branch built this rule.
		const dnsVisibilityRule = rules.find(
			(rule): rule is Readonly<Record<string, unknown>> =>
				isRecord(rule) &&
				isDeepStrictEqual(rule.toEndpoints, CILIUM_DNS_VISIBILITY_RULE.toEndpoints),
		)
		for (const rule of rules) {
			if (!isRecord(rule)) continue
			const hostNames = readList(rule.toFQDNs)
			if (hostNames === undefined || hostNames === 'unreadable') continue
			// This module built `rule` a few lines above (see the comment at the
			// top of this function), so its `toPorts` is always in the shape
			// `readCiliumRulePorts` reads — 'unreadable' cannot happen for a
			// manifest this file emitted, and 'all' is the safe fallback if it
			// somehow did, since that is what an absent `toPorts` also means.
			const portsRead = readCiliumRulePorts(rule)
			const ports = portsRead.ok ? portsRead.ports : 'all'
			for (const entry of hostNames) {
				if (isRecord(entry) && typeof entry.matchName === 'string') {
					fqdns.push({ host: entry.matchName, ports })
				}
			}
		}
		// This module built `dnsVisibilityRule` above (when it exists at all —
		// every Cilium translation this function reads carries one), so
		// `readCiliumRuleDnsNames` failing to read it, or reading a wildcard,
		// cannot mean anything other than "not narrowed": 'all' is the safe
		// fallback, the same reasoning `readCiliumRulePorts`'s own fallback above
		// already relies on.
		const dnsNamesRead =
			dnsVisibilityRule === undefined ? undefined : readCiliumRuleDnsNames(dnsVisibilityRule)
		const dnsNarrowedTo: 'all' | readonly string[] =
			dnsNamesRead?.ok === true && dnsNamesRead.names !== 'all' ? dnsNamesRead.names : 'all'
		return {
			// The core-shaped reading of CILIUM_DNS_VISIBILITY_RULE — the one
			// place in this module where one resource's rule is restated in the
			// other's vocabulary, so that a core policy allowing exactly cluster
			// DNS is not reported as widening a translation that already allows
			// it. Nothing else about a Cilium translation is restated: an
			// allowlist of names has no core spelling at all.
			destinations: [{ peer: RESOLVER_PEER, ports: [{ start: 53 }] }],
			fqdns,
			dnsNarrowedTo,
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
		// A core `NetworkPolicy` translation never narrows DNS — it has no L7
		// concept to narrow with — so the DNS-widening check in
		// `coreEgressRuleVerdict`/`ciliumEgressRuleVerdict` never fires against
		// this allowance.
		dnsNarrowedTo: 'all',
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

/** Is every port `wanted` reaches on `host` also allowed by some `fqdns` entry naming it. */
function fqdnIsAllowed(
	allowance: EgressAllowance,
	host: string,
	ports: 'all' | readonly PortRange[],
): boolean {
	const wanted: readonly PortRange[] = ports === 'all' ? [{}] : ports
	return wanted.every((range) =>
		allowance.fqdns.some((entry) => entry.host === host && portsCover(entry.ports, range)),
	)
}

/** Does `ports` (as a CANDIDATE rule's own port list) reach TCP or UDP 53 at all. */
function coversDnsPort(ports: 'all' | readonly PortRange[]): boolean {
	if (ports === 'all') return true
	return ports.some((range) => {
		if (range.protocol !== undefined && range.protocol !== 'UDP' && range.protocol !== 'TCP') {
			return false
		}
		if (range.start === undefined) return true
		return range.start <= 53 && (range.end ?? range.start) >= 53
	})
}

/**
 * Does a candidate rule's `peer`+`ports` reach the cluster resolver on the DNS
 * port at all — the precondition for the DNS-widening check both
 * {@link coreEgressRuleVerdict} and {@link ciliumEgressRuleVerdict} apply
 * before falling back to the ordinary peer/port `destinationIsAllowed` check.
 */
function reachesResolverAtDnsPort(peer: PolicyPeer, ports: 'all' | readonly PortRange[]): boolean {
	return peerIsWithin(peer, RESOLVER_PEER) && coversDnsPort(ports)
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
		// A plain `NetworkPolicy` has no L7 concept, so it cannot express the DNS
		// restriction `ciliumNarrowing.dnsNames` narrows to — a core rule
		// reaching the resolver on the DNS port always resolves every name, and
		// that is wider than a narrowed translation whatever its own peer/port
		// shape says. This has to be decided BEFORE `destinationIsAllowed`
		// below: that check only reasons about reachability, and our own
		// translation's `destinations` entry for the resolver is peer/port-only
		// too, so a plain kube-dns rule would otherwise read as `within` a
		// translation it actually resolves every name for.
		if (allowance.dnsNarrowedTo !== 'all' && reachesResolverAtDnsPort(read, ports)) {
			return {
				beyond: true,
				detail: `a 'to' peer ${describePeer(read)} on ${describePorts(ports)} reaching the cluster resolver's DNS port with no DNS-name restriction — a plain NetworkPolicy cannot narrow lookups the way the configured translation's ciliumNarrowing.dnsNames does, so this rule resolves every name the narrowed policy does not`,
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

/**
 * A Cilium rule's `toPorts`, read into the same {@link PortSet} core rules
 * use. Shared by {@link ciliumEgressRuleVerdict} (a CANDIDATE rule read off
 * the cluster) and {@link egressAllowance} (OUR OWN translated rule) so
 * there is one reading of "what ports does this Cilium rule reach", not two
 * that could silently disagree.
 */
type CiliumRulePorts =
	| { readonly ok: true; readonly ports: 'all' | readonly PortRange[] }
	| { readonly ok: false; readonly detail: string }

function readCiliumRulePorts(rule: Readonly<Record<string, unknown>>): CiliumRulePorts {
	// A Cilium rule carries its ports one level deeper, and a port entry with
	// no protocol means ANY rather than TCP.
	const toPorts = readList(rule.toPorts)
	if (toPorts === 'unreadable') {
		return { ok: false, detail: 'a toPorts that is not a list' }
	}
	const portEntries: unknown[] = []
	for (const entry of toPorts ?? []) {
		if (!isRecord(entry)) {
			return { ok: false, detail: 'a toPorts entry that is not an object' }
		}
		const list = readList(entry.ports)
		if (list === 'unreadable') {
			return { ok: false, detail: 'a toPorts ports field that is not a list' }
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
		return { ok: false, detail: 'a toPorts entry this check cannot read' }
	}
	return { ok: true, ports }
}

/**
 * A Cilium rule's `toPorts[].rules.dns`, read into the exact-name list it
 * restricts lookups to, or `'all'` when the rule does not restrict DNS at
 * all. Shared by {@link egressAllowance} (reading OUR OWN narrowed
 * DNS-visibility rule into {@link EgressAllowance.dnsNarrowedTo}) and
 * {@link ciliumEgressRuleVerdict} (deciding whether a CANDIDATE rule's own
 * restriction is narrow enough to not widen it) — one reading of "what names
 * does this Cilium rule let resolve", not two that could disagree.
 *
 * A `toPorts` entry with no `rules` at all, or a `rules.dns` entry carrying
 * `matchPattern` rather than `matchName`, both read as `'all'`: an absent L7
 * restriction resolves every name by definition, and this check does not
 * attempt to decide whether some wildcard pattern is a subset of an exact
 * name list — `'all'` is the conservative (never under-counts a widening)
 * answer for a shape it cannot reduce further.
 */
function readCiliumRuleDnsNames(
	rule: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly names: 'all' | readonly string[] } | { readonly ok: false } {
	const toPorts = readList(rule.toPorts)
	if (toPorts === 'unreadable') return { ok: false }
	const names: string[] = []
	for (const entry of toPorts ?? []) {
		if (!isRecord(entry)) return { ok: false }
		if (entry.rules === undefined) return { ok: true, names: 'all' }
		if (!isRecord(entry.rules)) return { ok: false }
		const dns = readList(entry.rules.dns)
		if (dns === 'unreadable') return { ok: false }
		if (dns === undefined) return { ok: true, names: 'all' }
		for (const item of dns) {
			if (!isRecord(item)) return { ok: false }
			if (typeof item.matchName === 'string') {
				names.push(item.matchName)
				continue
			}
			// `matchPattern` (Cilium's glob syntax) or anything else this reading
			// does not recognise — both are read as unrestricted rather than
			// guessed at, per the doc comment above.
			return { ok: true, names: 'all' }
		}
	}
	return { ok: true, names }
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
	const portsRead = readCiliumRulePorts(rule)
	if (!portsRead.ok) {
		return { beyond: 'unknown', detail: portsRead.detail }
	}
	const ports = portsRead.ports
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
		if (typeof matchName !== 'string' || !fqdnIsAllowed(allowance, matchName, ports)) {
			return {
				beyond: true,
				detail: `toFQDNs ${JSON.stringify(entry)} on ${describePorts(ports)}, which a '${allowance.policyKind}' translation does not allow`,
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
		// See the matching comment in `coreEgressRuleVerdict`: reachability alone
		// cannot tell a plain kube-dns rule from a narrowed one, so this has to
		// run before `destinationIsAllowed` below. Unlike a core rule, a Cilium
		// one CAN narrow DNS on its own `toPorts.rules.dns` — read it and accept
		// the rule only when what it names is a subset of what our own
		// translation narrows to.
		if (allowance.dnsNarrowedTo !== 'all' && reachesResolverAtDnsPort(peer, ports)) {
			const narrowedTo = allowance.dnsNarrowedTo
			const candidate = readCiliumRuleDnsNames(rule)
			const isSubset =
				candidate.ok &&
				candidate.names !== 'all' &&
				candidate.names.every((n) => narrowedTo.includes(n))
			if (!isSubset) {
				return {
					beyond: true,
					detail: `toEndpoints ${describePeer(peer)} on ${describePorts(ports)} reaching the cluster resolver's DNS port with ${candidate.ok && candidate.names !== 'all' ? 'a rules.dns list this check cannot confirm is a subset of' : 'no rules.dns restriction at least as narrow as'} the configured translation's ciliumNarrowing.dnsNames`,
				}
			}
			continue
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
