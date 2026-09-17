/**
 * Ingress verification: refuse a sandbox whose agent port no applied policy
 * closes.
 *
 * Sibling of `egress-policy.ts`, and deliberately shaped like its
 * `verifyEgressPolicyApplied` half rather than its translation half — this
 * module NEVER computes a manifest and never creates an object. Operators
 * apply the boundary; this backend reads what the cluster actually holds and
 * refuses when the boundary is not there. That is the same rule the egress
 * path documents, for the same reason: the network boundary should be
 * reviewed by whoever has cluster-admin, not written by whatever created the
 * ServiceAccount token this backend runs with.
 *
 * ## Why this exists at all
 *
 * Two shipped comments call the ingress policy the boundary on the agent
 * port — `workspace.ts`'s create path ("the NetworkPolicy rather than the
 * bind token is the boundary on its agent port") and the guest agent's own
 * source ("the network rule in front of the port is the boundary") — and
 * until this module nothing checked one existed. The gap was not theoretical:
 * measured on a managed cluster, sandbox pods this backend POSTed had
 * enforcement on egress only, their agent port answered from every source
 * tried (another namespace, another node, a host-network pod), and no request
 * anywhere in the backend would have noticed.
 *
 * The reason it read as covered is worth keeping written down, because the
 * manifests still carry the shape that produced it. A `SandboxTemplate`'s
 * inline `networkPolicy` block is translated by the agent-sandbox controller
 * into a policy selecting `agents.x-k8s.io/sandbox-template-ref-hash` — a
 * label written only onto a Sandbox ADOPTED out of a `SandboxWarmPool`, never
 * onto one this backend POSTs (see `objects.ts`'s
 * {@link SANDBOX_TEMPLATE_LABEL_KEY} comment). Every workspace, and every
 * pool-less task sandbox, is POSTed. So the policy that looked like coverage
 * selected none of them, and the standalone manifest that DOES select them
 * (`k8s/manifests/networkpolicy.yaml`, whose `podSelector` matches
 * {@link SANDBOX_TEMPLATE_LABEL_KEY} by existence) was verified by nothing —
 * an operator who skipped that one file got a silently open port.
 *
 * ## The decision, in one paragraph
 *
 * Policies UNION. Kubernetes admits a connection if ANY policy selecting the
 * pod allows it, and a pod selected by no ingress-enforcing policy at all is
 * allowed everything. So two things have to hold, not one: at least one
 * policy that enforces ingress must select the pod, AND no policy selecting
 * the pod may admit a wide-open peer on the agent port. One open rule opens
 * the port however many closed ones sit beside it — that is the resource's
 * semantics, not a heuristic this module chose.
 *
 * ## What it reads, and what it cannot see
 *
 * It LISTS the namespace's policies and evaluates their selectors against the
 * pod's real labels. It never GETs a policy by name: an object with the right
 * name proves the object exists, not that it selects this pod — a selector
 * with a stale template value would pass a name check and cover nothing.
 *
 * Before the POST the only labels that exist are the ones the create body
 * stamps; the agent-sandbox controller writes more of its own onto the object
 * afterwards. For COVERAGE that is fail-closed — a policy selecting a
 * controller-written label does not count, so the create is refused rather
 * than admitted. For an OPENING it is not: a wide-open rule whose selector
 * keys on such a label reads as not selecting this pod. The claim path has no
 * such gap, because there the pod already exists and its own labels are read.
 *
 * What a namespaced Role cannot read is the honest limit, and it is a
 * CONFIGURATION rather than a defect: a cluster-scoped policy (the clusterwide
 * arm of the Cilium CRD is a different, cluster-scoped kind), a service mesh's
 * own authorization layer, or a cloud-level security group can all close the
 * port somewhere this check cannot look. Such a deployment sets
 * `ingress: 'unverified'`, which reads no policy and issues no request. That
 * is a supported configuration with a name, not a smell — what is NOT
 * supported is a deployment that believes it is covered because nothing said
 * otherwise.
 *
 * ## Why the refusal is on by default
 *
 * The operator who needs this check is precisely the one who does not know
 * the port is open. An opt-in check would be read by the deployments that
 * already closed the port and skipped by the ones that did not. Failing
 * closed with a named opt-out is how the egress path already behaves — it
 * refuses rather than degrades — and it is the only arrangement under which
 * the measurement above turns into an error message instead of a quiet
 * success.
 */

import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	KubernetesCredentialError,
} from './k8s-client.js'
import {
	SANDBOX_TEMPLATE_LABEL_KEY,
	ciliumNetworkPolicyCollectionPath,
	networkPolicyCollectionPath,
} from './objects.js'

/**
 * Which policy resources the check enumerates.
 *
 *  - `'core'` (the default) lists `NetworkPolicy` — every cluster serves it,
 *    and a cluster running a CNI with its own CRD still enforces plain
 *    `NetworkPolicy` objects too, so this is never the wrong list, only
 *    sometimes an incomplete one.
 *  - `'cilium'` lists `CiliumNetworkPolicy` AS WELL — not instead. A cluster
 *    running that CNI typically carries both kinds, and an open rule in
 *    either one opens the port.
 */
export type KubernetesIngressEngine = 'core' | 'cilium'

/**
 * The config-level ingress hook on `KubernetesBackendConfig`.
 *
 * `undefined` means VERIFY with the default engine — this is the one config
 * field in this backend whose absent value is the strict one, because the
 * deployments that need the check are the ones that would never have set it.
 * `'unverified'` is the explicit opt-out for a deployment whose boundary
 * lives somewhere a namespaced Role cannot read; it issues no request at all.
 */
export type KubernetesIngressConfig =
	| {
			/** Defaults to `config.egress?.engine ?? 'core'`. See the type doc. */
			readonly engine?: KubernetesIngressEngine
	  }
	| 'unverified'

/** `true` when `ingress` is anything other than the `'unverified'` opt-out. */
export function ingressVerificationEnabled(ingress: KubernetesIngressConfig | undefined): boolean {
	return ingress !== 'unverified'
}

/**
 * Which resources to enumerate, given both policy-shaped config fields.
 *
 * The default deliberately follows `config.egress.engine`: a deployment that
 * already told this backend which policy engine its cluster runs should not
 * have to say it twice, and the far more likely mistake is declaring it once
 * and having the ingress check quietly read the wrong CRD.
 */
export function resolveIngressEngine(
	ingress: KubernetesIngressConfig | undefined,
	egressEngine: KubernetesIngressEngine | undefined,
): KubernetesIngressEngine {
	if (ingress !== undefined && ingress !== 'unverified' && ingress.engine !== undefined) {
		return ingress.engine
	}
	return egressEngine ?? 'core'
}

/** The pod the check is about, and the port that has to be closed on it. */
export interface IngressVerificationTarget {
	readonly namespace: string
	/**
	 * The pod's REAL labels — for a directly created Sandbox the labels the
	 * create body stamps (known before the POST, so a refusal leaves no
	 * Sandbox and no PVC behind), for a claimed one the bound pod's own
	 * `metadata.labels`. Never a policy name: a name proves an object exists,
	 * a label is what a selector actually matches.
	 */
	readonly podLabels: Readonly<Record<string, string>>
	readonly agentPort: number
	readonly engine: KubernetesIngressEngine
	/** How the refusal names the thing being created, e.g. `Sandbox namzu-ws-demo`. */
	readonly subject: string
}

/** What one examined policy turned out to be. One line of the refusal. */
export type IngressPolicyVerdict =
	/** Selects the pod, enforces ingress, admits nothing wide open on the port. */
	| 'covers'
	/** Selects the pod and admits a wide-open peer on the agent port. */
	| 'opens-agent-port'
	/** Its selector does not match the pod's labels. */
	| 'does-not-select'
	/** Selects the pod but does not enforce ingress, so it neither covers nor opens. */
	| 'not-ingress-scoped'
	/** Contains something this check cannot decide — see {@link IngressPolicyRefusal}. */
	| 'not-evaluable'

/** One policy, as the refusal reports it. */
export interface ExaminedIngressPolicy {
	readonly kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
	readonly name: string
	readonly verdict: IngressPolicyVerdict
	/** Why, for every verdict that is not a plain match or non-match. */
	readonly detail?: string
}

/**
 * Which of the three refusals this is. They are three different operator
 * actions, which is why the error carries them apart rather than folding
 * them into one message:
 *
 *  - `no-covering-policy` — apply the missing policy.
 *  - `port-open` — fix or delete the policy that is standing the door open.
 *  - `not-evaluable` — this check cannot decide; grant the missing verb, or
 *    declare `ingress: 'unverified'` because the boundary is somewhere it
 *    cannot look.
 */
export type IngressPolicyRefusal = 'no-covering-policy' | 'port-open' | 'not-evaluable'

/**
 * A policy collection a check could NOT read, and why.
 *
 * It exists because an empty `examined` list means two different things and
 * nothing else tells them apart: the namespace holds no policy of the kinds
 * read, which is a fact about the CLUSTER, or no list was read at all, which
 * is a fact about this CHECK. Reporting the first when the second happened is
 * the defect this whole module exists to delete, one layer down.
 *
 * Shared with the EGRESS direction — `egress-policy.ts`'s union check reads
 * the same two collections through the same {@link listPolicies} and reports
 * the same failure the same way. See "Shared with the egress direction".
 */
export interface UnreadPolicySource {
	readonly resource: 'networkpolicies' | 'ciliumnetworkpolicies'
	readonly path: string
	/**
	 *  - `'absent'` — the API server served no such collection here.
	 *  - `'forbidden'` — it refused the read.
	 *
	 * They are different operator actions, which is why the remedy sentence
	 * branches on this rather than on the message.
	 */
	readonly why: 'absent' | 'forbidden'
	/** The failure in its own terms, for the reader of the message. */
	readonly reason: string
}

/**
 * @deprecated Renamed to {@link UnreadPolicySource} when the egress union
 * check began reporting the same record; this alias keeps the old name
 * working and will be removed in a later major.
 */
export type UnreadIngressPolicySource = UnreadPolicySource

/**
 * The named refusal. Distinct from every other refusal this backend can
 * raise on a create path, so a caller (or an operator reading a log line)
 * can tell an unprotected agent port from a slow API server or an
 * unenforceable egress policy without matching on a message.
 *
 * It carries the pod's labels and EVERY policy examined, with a verdict each,
 * because that list is the operator's whole debugging session: the question
 * "why does my policy not count?" is answered by the line that says it did
 * not select these labels.
 *
 * Every sentence of the message is a claim the read actually supports. When a
 * collection could not be enumerated it lands in {@link unread} and the
 * message says so instead of describing a namespace nobody looked at — see
 * {@link UnreadPolicySource}.
 */
export class KubernetesIngressPolicyError extends Error {
	override readonly name = 'KubernetesIngressPolicyError'

	constructor(
		readonly refusal: IngressPolicyRefusal,
		readonly subject: string,
		readonly podLabels: Readonly<Record<string, string>>,
		readonly agentPort: number,
		readonly examined: readonly ExaminedIngressPolicy[],
		summary: string,
		/** Empty on every decision made from policies that WERE read. */
		readonly unread: readonly UnreadPolicySource[] = [],
	) {
		super(
			`kubernetes: refusing ${subject} — ${summary} The pod's labels are ${formatLabels(podLabels)} and the agent port is TCP ${agentPort}. ${formatExamined(examined, unread)} Kubernetes UNIONS every policy selecting a pod, so the port is closed only when at least one ingress-enforcing policy selects it and none of them admits a wide-open peer on that port. ${formatRemedy(unread, examined)}`,
		)
	}
}

/**
 * One label set, rendered for a refusal message. Exported for the egress
 * union check's refusal, which has to render the identical thing.
 */
export function formatLabels(labels: Readonly<Record<string, string>>): string {
	const entries = Object.entries(labels)
	if (entries.length === 0) return '(none)'
	return entries
		.map(([key, value]) => `${key}=${value}`)
		.sort()
		.join(', ')
}

/**
 * The examined list, and — this is the whole point of the function — what an
 * EMPTY one is allowed to say.
 *
 * "The namespace holds no policy" is a claim about the cluster, and only a
 * list that came back empty supports it. A list that was refused or never
 * served supports nothing at all, so `unread` and not the length picks the
 * wording, and the kinds that went unread are named.
 */
function formatExamined(
	examined: readonly ExaminedIngressPolicy[],
	unread: readonly UnreadPolicySource[],
): string {
	let head: string
	if (examined.length > 0) {
		head = `Policies examined: ${examined
			.map(
				(policy) =>
					`${policy.kind}/${policy.name} [${policy.verdict}${policy.detail !== undefined ? `: ${policy.detail}` : ''}]`,
			)
			.join('; ')}.`
	} else if (unread.length > 0) {
		head =
			'Policies examined: none, and none could be read — nothing here is a claim about what this namespace holds.'
	} else {
		head = 'Policies examined: (none — the namespace holds no policy of the kinds read).'
	}
	if (unread.length === 0) return head
	return `${head} Not read: ${unread
		.map((source) => `${source.resource} at ${source.path} (${source.reason})`)
		.join('; ')}.`
}

/**
 * What the operator does next. It branches on {@link UnreadPolicySource}
 * because "apply the missing policy" is the wrong instruction for a check that
 * never got to look at one: the fix there is to make the list readable, or to
 * declare that the boundary lives where this check cannot see it.
 *
 * It takes `examined` for the same reason {@link formatExamined} does, and it
 * is the same claim: "this backend read no policy at all" is a sentence only
 * an EMPTY examined list supports. One collection can go unread beside another
 * that was read and named — a 404 on the Cilium CRD after the core list came
 * back — and saying nothing was read three sentences after listing what was
 * read is exactly the kind of unsupported sentence this module exists to
 * delete.
 */
function formatRemedy(
	unread: readonly UnreadPolicySource[],
	examined: readonly ExaminedIngressPolicy[],
): string {
	const unverified = `If this deployment closes the port somewhere a namespaced Role cannot read — a cluster-scoped policy, a service mesh, a cloud security group — set ingress: 'unverified' on the backend config to say so explicitly; see docs/sdk/kubernetes-sandbox.md's ingress section.`
	if (unread.length === 0) {
		return `This backend never creates the policy itself — apply k8s/manifests/networkpolicy.yaml (or your own equivalent selecting ${SANDBOX_TEMPLATE_LABEL_KEY}) and try again. ${unverified}`
	}
	const actions: string[] = []
	const forbidden = unread.filter((source) => source.why === 'forbidden')
	if (forbidden.length > 0) {
		actions.push(
			`grant this ServiceAccount 'list' on ${forbidden
				.map((source) => source.resource)
				.join(' and ')} in this namespace, which k8s/manifests/rbac.yaml does`,
		)
	}
	const absent = unread.filter((source) => source.why === 'absent')
	if (absent.length > 0) {
		actions.push(
			`point ingress.engine at a policy kind this cluster actually serves (${absent
				.map((source) => source.resource)
				.join(' and ')} answered as not served here)`,
		)
	}
	const missing =
		unread.length === 1 ? 'one collection was not' : `${unread.length} collections were not`
	const preamble =
		examined.length === 0
			? 'This backend read no policy at all, so it can name none to fix:'
			: `The policies named above were read; ${missing}, so what the rest of the cluster admits on the agent port is unknown:`
	return `${preamble} ${actions.join(', or ')}. ${unverified}`
}

// ---------------------------------------------------------------------------
// Reading the wire.
//
// The shapes below are partial in the same way `objects.ts`'s are, and for the
// same reason: a full copy of two policy schemas would go stale on its own
// schedule. What they are NOT is a promise about what arrives — every reader
// below takes `unknown` and narrows, so the type declarations document the
// schema and the code cannot quietly assume it.
//
// The rule, and it holds with no exception: a field that is present as
// something other than what the schema declares contributes `'unknown'` —
// `not-evaluable`, a REFUSAL — and never a value in either direction. Reading
// an unreadable `spec.ingress` as "no rules" would report a policy as covering
// the agent port on the strength of a field nobody could read, which is the
// same shape of mistake as the shipped comments this module was written to
// delete.
//
// An ABSENT field is different from an unreadable one and each reader says
// what absent means there, because the resources themselves differ: an absent
// `ports` on an ingress rule means every port, an absent `policyTypes` is
// defaulted by the API server to include Ingress, and an absent `ingress` is
// no rules at all.
// ---------------------------------------------------------------------------

/**
 * A JSON object, and not `null` and not an array.
 *
 * `typeof null === 'object'` and `typeof [] === 'object'` are the two ways a
 * check meaning "is this an object" gets written and stays wrong.
 */
// ---------------------------------------------------------------------------
// Shared with the egress direction
// ---------------------------------------------------------------------------
//
// The exported helpers from here to the end of "Selector evaluation", plus
// `listPolicies` in the I/O half below, are called by `egress-policy.ts`'s
// union check as well as by this module's own decision. There is ONE
// enumeration of the policies selecting a pod in this package and ONE reading
// of what a peer is, serving both directions: two would be two definitions of
// "wide open" and two ways to disagree with the cluster about which policies
// apply. The egress check asks a different QUESTION of the same material —
// "is this peer inside the configured translation" rather than "does this
// rule open the agent port" — and so keeps its own verdict types there.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * How a field the schema declares as a LIST reads.
 *
 *  - `undefined` — absent (`null` included: that is how a serialiser spells
 *    absent, and the API server never sends it otherwise). What absent means
 *    is the caller's to decide.
 *  - the array — present and readable.
 *  - `'unreadable'` — present as something that is not a list.
 */
export type ReadList = readonly unknown[] | undefined | 'unreadable'

export function readList(value: unknown): ReadList {
	if (value === undefined || value === null) return undefined
	return Array.isArray(value) ? value : 'unreadable'
}

/** A policy's name, or a stable stand-in — never a non-string off the wire. */
export function policyName(item: unknown, index: number): string {
	const metadata = isRecord(item) ? item.metadata : undefined
	const name = isRecord(metadata) ? metadata.name : undefined
	return typeof name === 'string' && name !== '' ? name : `(unnamed #${index})`
}

/**
 * A policy that could not be read, as a document.
 *
 * {@link IngressPolicyDocument.unreadable} decides on its own, so the other
 * fields are the inert ones: nothing downstream consults them.
 */
function unreadablePolicy(
	kind: IngressPolicyDocument['kind'],
	name: string,
	detail: string,
): IngressPolicyDocument {
	return {
		kind,
		name,
		selects: 'unknown',
		enforcesIngress: false,
		rules: [],
		unreadable: detail,
	}
}

interface LabelSelector {
	readonly matchLabels?: Readonly<Record<string, string>>
	readonly matchExpressions?: readonly {
		readonly key?: string
		readonly operator?: string
		readonly values?: readonly string[]
	}[]
}

interface PolicyListResource {
	readonly items?: unknown
}

/**
 * One policy, normalised to the three questions the decision actually asks:
 * does it select this pod, does it enforce ingress on it, and what does it
 * let in. Both resource kinds collapse onto this, so the union rule is
 * implemented once.
 */
export interface IngressPolicyDocument {
	readonly kind: 'NetworkPolicy' | 'CiliumNetworkPolicy'
	readonly name: string
	readonly selects: SelectorMatch
	/**
	 * Does this policy put the pod into ingress DEFAULT-DENY — which is the
	 * only thing that makes it count as coverage. A core policy whose
	 * `policyTypes` leaves Ingress out does not, and neither does a Cilium
	 * rule carrying `enableDefaultDeny.ingress: false`.
	 */
	readonly enforcesIngress: boolean
	/**
	 * Per-rule: does this rule admit a wide-open peer on the agent port.
	 *
	 * Only rules that APPLY are carried, which is not the same question as
	 * {@link enforcesIngress}: a core policy that leaves Ingress out of
	 * `policyTypes` has its ingress block ignored by the API server outright
	 * and so carries no rules at all, while a Cilium rule that disables
	 * default-deny still admits everything it names — it simply cannot be the
	 * policy that closes the port.
	 */
	readonly rules: readonly IngressRuleVerdict[]
	/**
	 * Set when the OBJECT could not be read — a field the schema declares one
	 * way arriving as another. It decides alone: a document carrying it is
	 * `not-evaluable` whatever the fields that did parse happen to say,
	 * because a policy that cannot be read cannot be shown to close a port.
	 */
	readonly unreadable?: string
}

/** `'unknown'` is never guessed either way — see {@link IngressPolicyRefusal}. */
export type SelectorMatch = 'yes' | 'no' | 'unknown'

export interface IngressRuleVerdict {
	readonly open: boolean | 'unknown'
	readonly detail?: string
}

// ---------------------------------------------------------------------------
// Selector evaluation
// ---------------------------------------------------------------------------

/**
 * Is this a selector this check can read at all?
 *
 * An ABSENT selector is readable — the resource defines it as "everything".
 * A present one that is not an object, or whose `matchLabels` /
 * `matchExpressions` are not the shapes the API declares, is not, and every
 * caller turns that into `'unknown'`. A selector that might match a pod might
 * also be the one holding its port open, so neither "matches" nor "does not
 * match" is available.
 */
export function selectorIsReadable(selector: unknown): boolean {
	if (selector === undefined) return true
	if (!isRecord(selector)) return false
	const matchLabels = selector.matchLabels
	if (matchLabels !== undefined) {
		if (!isRecord(matchLabels)) return false
		for (const value of Object.values(matchLabels)) if (typeof value !== 'string') return false
	}
	const matchExpressions = selector.matchExpressions
	if (matchExpressions !== undefined && !Array.isArray(matchExpressions)) return false
	return true
}

function selectorIsEmpty(selector: LabelSelector | undefined): boolean {
	if (selector === undefined) return true
	const labels = selector.matchLabels
	const expressions = selector.matchExpressions
	const hasLabels = labels !== undefined && Object.keys(labels).length > 0
	const hasExpressions = Array.isArray(expressions) && expressions.length > 0
	return !hasLabels && !hasExpressions
}

/**
 * A label selector against a known label set.
 *
 * An ABSENT or EMPTY selector matches everything — that is the resource's own
 * default (`podSelector: {}` is how a `NetworkPolicy` selects every pod in
 * its namespace), not a lenient reading.
 *
 * `normaliseKey` exists for the Cilium arm: that CRD's selectors carry a
 * label SOURCE prefix (`k8s:app`, `any:app`), and an unprefixed key means
 * `any:`. A prefix this module does not understand makes the whole selector
 * `'unknown'` rather than "does not match", because a selector that might
 * match a pod might also be the one holding its port open.
 *
 * Label values are read with `labelValue`, never by indexing: a label key is
 * allowed to be spelled `constructor`, and a plain object would answer that
 * one off `Object.prototype` — an `Exists` expression on it would then report
 * a pod as selected by a policy that does not select it.
 */
function labelValue(labels: Readonly<Record<string, string>>, key: string): string | undefined {
	return Object.hasOwn(labels, key) ? labels[key] : undefined
}

export function matchesLabelSelector(
	selector: unknown,
	labels: Readonly<Record<string, string>>,
	normaliseKey: (key: string) => string | undefined = (key) => key,
): SelectorMatch {
	if (!selectorIsReadable(selector)) return 'unknown'
	const readable = selector as LabelSelector | undefined
	if (selectorIsEmpty(readable)) return 'yes'
	for (const [rawKey, value] of Object.entries(readable?.matchLabels ?? {})) {
		const key = normaliseKey(rawKey)
		if (key === undefined) return 'unknown'
		if (labelValue(labels, key) !== value) return 'no'
	}
	for (const expression of readable?.matchExpressions ?? []) {
		if (!isRecord(expression)) return 'unknown'
		const rawKey = expression.key
		if (typeof rawKey !== 'string' || rawKey === '') return 'unknown'
		const key = normaliseKey(rawKey)
		if (key === undefined) return 'unknown'
		const actual = labelValue(labels, key)
		const operator = expression.operator
		if (operator === 'Exists') {
			if (actual === undefined) return 'no'
			continue
		}
		if (operator === 'DoesNotExist') {
			if (actual !== undefined) return 'no'
			continue
		}
		if (operator !== 'In' && operator !== 'NotIn') return 'unknown'
		// `values` is what In and NotIn are ABOUT. Reading an unreadable one
		// as the empty list would answer NotIn with "matches" — a pod
		// reported as selected on the strength of a field nobody could read.
		const values = readList(expression.values)
		if (values === 'unreadable' || values === undefined) return 'unknown'
		if (operator === 'In') {
			if (actual === undefined || !values.includes(actual)) return 'no'
			continue
		}
		// A pod that carries the key not at all satisfies NotIn, which is the
		// API's own rule and the opposite of the intuitive read.
		if (actual !== undefined && values.includes(actual)) return 'no'
	}
	return 'yes'
}

/**
 * Strip the label SOURCE prefix off a Cilium selector key, or report that it
 * is one this check cannot map onto a pod label.
 *
 * `k8s:` and `any:` both resolve to the pod's own labels; `reserved:` and the
 * other sources name identities that are not pod labels at all, and guessing
 * at one would be exactly the "trust the shape" mistake this module exists to
 * avoid.
 */
export function ciliumSelectorKey(key: string): string | undefined {
	const colon = key.indexOf(':')
	if (colon < 0) return key
	const source = key.slice(0, colon)
	if (source === 'k8s' || source === 'any') return key.slice(colon + 1)
	return undefined
}

/**
 * The label set a Cilium selector is matched against: the pod's own labels
 * plus the namespace, which that CRD's selectors name as
 * `io.kubernetes.pod.namespace` and which every namespaced policy in the
 * shipped examples carries.
 */
export function ciliumIdentityLabels(
	podLabels: Readonly<Record<string, string>>,
	namespace: string,
): Readonly<Record<string, string>> {
	return { ...podLabels, 'io.kubernetes.pod.namespace': namespace }
}

// ---------------------------------------------------------------------------
// Port and peer evaluation
// ---------------------------------------------------------------------------

function coreRuleCoversPort(ports: unknown, agentPort: number): boolean | 'unknown' {
	const entries = readList(ports)
	if (entries === 'unreadable') return 'unknown'
	// Absent or empty `ports` on an ingress rule means EVERY port — the one
	// shape most likely to be read as "no ports, so nothing".
	if (entries === undefined || entries.length === 0) return true
	let unknown = false
	for (const entry of entries) {
		if (!isRecord(entry)) {
			unknown = true
			continue
		}
		const rawProtocol = entry.protocol
		if (rawProtocol !== undefined && typeof rawProtocol !== 'string') {
			unknown = true
			continue
		}
		if ((rawProtocol ?? 'TCP') !== 'TCP') continue
		const endPort = entry.endPort
		if (endPort !== undefined && typeof endPort !== 'number') {
			unknown = true
			continue
		}
		const port = entry.port
		if (port === undefined) return true
		const spansAgentPort = (start: number): boolean =>
			typeof endPort === 'number' && agentPort > start && agentPort <= endPort
		if (typeof port === 'number') {
			if (port === agentPort || spansAgentPort(port)) return true
			continue
		}
		if (typeof port === 'string') {
			const parsed = Number(port)
			if (Number.isInteger(parsed) && String(parsed) === port.trim()) {
				if (parsed === agentPort || spansAgentPort(parsed)) return true
				continue
			}
			// A NAMED container port. Resolving it needs the pod's own
			// container spec, which this check does not have on every path
			// (a claimed pool sandbox's spec is the pool's), so it is
			// reported rather than assumed either way.
			unknown = true
			continue
		}
		unknown = true
	}
	return unknown ? 'unknown' : false
}

const WIDE_OPEN_CIDRS = new Set(['0.0.0.0/0', '::/0'])

export function corePeerIsWideOpen(peer: unknown): boolean | 'unknown' {
	if (!isRecord(peer)) return 'unknown'
	const { podSelector, namespaceSelector, ipBlock } = peer
	if (ipBlock !== undefined) {
		if (!isRecord(ipBlock)) return 'unknown'
		const cidr = ipBlock.cidr
		if (typeof cidr !== 'string') return 'unknown'
		// An `except` list carves a few addresses out of the whole internet
		// and leaves the rest of it admitted, so it does not narrow this to
		// anything worth calling closed.
		return WIDE_OPEN_CIDRS.has(cidr.trim())
	}
	if (!selectorIsReadable(podSelector) || !selectorIsReadable(namespaceSelector)) return 'unknown'
	if (namespaceSelector !== undefined) {
		// `namespaceSelector: {}` is every namespace. Paired with a
		// non-empty podSelector it is still a real constraint (that pod
		// label, anywhere), so only the doubly-empty form is wide open.
		return (
			selectorIsEmpty(namespaceSelector as LabelSelector) &&
			selectorIsEmpty(podSelector as LabelSelector | undefined)
		)
	}
	if (podSelector !== undefined) {
		// Every pod in the policy's own namespace. Broad, and deliberately
		// NOT called wide open: naming it so would refuse the legitimate
		// "the host runs beside its sandboxes" deployment, and an evaluator
		// that fires on a correct policy is one an operator switches off.
		return false
	}
	// A peer naming none of the three constrains nothing. The API server
	// rejects it on admission, so reaching here means the object did not come
	// from one.
	return 'unknown'
}

function coreRuleVerdict(rule: unknown, agentPort: number): IngressRuleVerdict {
	if (!isRecord(rule)) {
		return { open: 'unknown', detail: 'an ingress rule that is not an object' }
	}
	const covers = coreRuleCoversPort(rule.ports, agentPort)
	if (covers === 'unknown') {
		return {
			open: 'unknown',
			detail: `a named port this check cannot resolve to TCP ${agentPort}, or a ports entry it cannot read`,
		}
	}
	if (covers === false) return { open: false }
	const from = readList(rule.from)
	if (from === 'unreadable') {
		return { open: 'unknown', detail: "a 'from' that is not a list of peers" }
	}
	if (from === undefined || from.length === 0) {
		// No `from` on an ingress rule means EVERY source.
		return {
			open: true,
			detail: `no 'from' peers, so every source reaches TCP ${agentPort}`,
		}
	}
	let unknown: string | undefined
	for (const peer of from) {
		const open = corePeerIsWideOpen(peer)
		if (open === true) {
			return {
				open: true,
				detail: `a wide-open 'from' peer (${JSON.stringify(peer)}) on TCP ${agentPort}`,
			}
		}
		if (open === 'unknown')
			unknown ??= `a 'from' peer this check cannot read (${JSON.stringify(peer)})`
	}
	if (unknown !== undefined) return { open: 'unknown', detail: unknown }
	return { open: false }
}

/** `all`, `cluster` and `world` each admit a peer set no host selector bounds. */
const WIDE_OPEN_ENTITIES = new Set(['all', 'cluster', 'world'])

function ciliumRuleCoversPort(
	rule: Readonly<Record<string, unknown>>,
	agentPort: number,
): boolean | 'unknown' {
	const toPorts = readList(rule.toPorts)
	if (toPorts === 'unreadable') return 'unknown'
	if (toPorts === undefined || toPorts.length === 0) return true
	let unknown = false
	for (const entry of toPorts) {
		if (!isRecord(entry)) {
			unknown = true
			continue
		}
		const ports = readList(entry.ports)
		if (ports === 'unreadable') {
			unknown = true
			continue
		}
		if (ports === undefined || ports.length === 0) return true
		for (const port of ports) {
			if (!isRecord(port)) {
				unknown = true
				continue
			}
			const rawProtocol = port.protocol
			if (rawProtocol !== undefined && typeof rawProtocol !== 'string') {
				unknown = true
				continue
			}
			const protocol = (rawProtocol ?? 'ANY').toUpperCase()
			if (protocol !== 'TCP' && protocol !== 'ANY') continue
			const endPort = port.endPort
			if (endPort !== undefined && typeof endPort !== 'number') {
				unknown = true
				continue
			}
			const raw = port.port
			if (raw === undefined) return true
			if (typeof raw !== 'number' && typeof raw !== 'string') {
				unknown = true
				continue
			}
			const parsed = typeof raw === 'number' ? raw : Number(raw)
			if (!Number.isInteger(parsed)) {
				unknown = true
				continue
			}
			if (parsed === agentPort) return true
			if (typeof endPort === 'number' && agentPort > parsed && agentPort <= endPort) return true
		}
	}
	return unknown ? 'unknown' : false
}

/** Every `from…` field the CRD declares. A rule naming none of them is port-only. */
const CILIUM_SOURCE_FIELDS = [
	'fromEndpoints',
	'fromEntities',
	'fromCIDR',
	'fromCIDRSet',
	'fromNodes',
	'fromGroups',
] as const

function ciliumRuleVerdict(rule: unknown, agentPort: number): IngressRuleVerdict {
	if (!isRecord(rule)) {
		return { open: 'unknown', detail: 'an ingress rule that is not an object' }
	}
	const covers = ciliumRuleCoversPort(rule, agentPort)
	if (covers === 'unknown') {
		return {
			open: 'unknown',
			detail: `a toPorts entry this check cannot read against TCP ${agentPort}`,
		}
	}
	if (covers === false) return { open: false }

	// Every source field is read BEFORE any of them is judged: one that is
	// present as something other than a list could be the wide-open one, and
	// skipping it would let the rule read as narrow on the strength of the
	// fields that happened to parse.
	const sources = new Map<(typeof CILIUM_SOURCE_FIELDS)[number], readonly unknown[]>()
	for (const field of CILIUM_SOURCE_FIELDS) {
		const list = readList(rule[field])
		if (list === 'unreadable') {
			return {
				open: 'unknown',
				detail: `a ${field} that is not a list of peers`,
			}
		}
		if (list !== undefined) sources.set(field, list)
	}

	for (const entity of sources.get('fromEntities') ?? []) {
		if (typeof entity !== 'string') {
			return {
				open: 'unknown',
				detail: 'a fromEntities entry that is not an entity name',
			}
		}
		if (WIDE_OPEN_ENTITIES.has(entity)) {
			return {
				open: true,
				detail: `fromEntities includes '${entity}' on TCP ${agentPort}`,
			}
		}
	}
	for (const cidr of sources.get('fromCIDR') ?? []) {
		if (typeof cidr !== 'string') {
			return {
				open: 'unknown',
				detail: 'a fromCIDR entry that is not a CIDR string',
			}
		}
		if (WIDE_OPEN_CIDRS.has(cidr.trim())) {
			return {
				open: true,
				detail: `fromCIDR includes ${cidr} on TCP ${agentPort}`,
			}
		}
	}
	for (const entry of sources.get('fromCIDRSet') ?? []) {
		if (!isRecord(entry)) {
			return {
				open: 'unknown',
				detail: 'a fromCIDRSet entry that is not an object',
			}
		}
		const cidr = entry.cidr
		if (cidr !== undefined && typeof cidr !== 'string') {
			return {
				open: 'unknown',
				detail: 'a fromCIDRSet cidr that is not a CIDR string',
			}
		}
		if (typeof cidr === 'string' && WIDE_OPEN_CIDRS.has(cidr.trim())) {
			return {
				open: true,
				detail: `fromCIDRSet includes ${cidr} on TCP ${agentPort}`,
			}
		}
	}
	for (const field of ['fromEndpoints', 'fromNodes'] as const) {
		for (const selector of sources.get(field) ?? []) {
			if (!selectorIsReadable(selector)) {
				return {
					open: 'unknown',
					detail: `a ${field} entry this check cannot read as a selector`,
				}
			}
		}
	}

	const hasSource = CILIUM_SOURCE_FIELDS.some((field) => (sources.get(field)?.length ?? 0) > 0)
	if (!hasSource) {
		// A port-only ingress rule admits every source on those ports — the
		// same shape as core's absent `from`, spelled differently.
		return {
			open: true,
			detail: `a port-only ingress rule, so every source reaches TCP ${agentPort}`,
		}
	}
	return { open: false }
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Every core `NetworkPolicy` in the list, reduced to {@link IngressPolicyDocument}. */
export function readCoreIngressPolicies(
	items: readonly unknown[],
	target: IngressVerificationTarget,
): IngressPolicyDocument[] {
	return items.map((item, index) => {
		const name = policyName(item, index)
		if (!isRecord(item)) {
			return unreadablePolicy('NetworkPolicy', name, 'a list entry that is not a policy object')
		}
		const spec = item.spec
		if (!isRecord(spec)) {
			return unreadablePolicy('NetworkPolicy', name, 'a spec that is not an object')
		}
		// An absent `policyTypes` is defaulted by the API server, and its
		// default ALWAYS includes Ingress. Only an explicit list that leaves
		// it out turns ingress enforcement off — and a `policyTypes` that is
		// not a list says nothing about either.
		const policyTypes = readList(spec.policyTypes)
		if (policyTypes === 'unreadable') {
			return unreadablePolicy('NetworkPolicy', name, 'a spec.policyTypes that is not a list')
		}
		const rules = readList(spec.ingress)
		if (rules === 'unreadable') {
			return unreadablePolicy('NetworkPolicy', name, 'a spec.ingress that is not a list of rules')
		}
		const enforcesIngress = policyTypes === undefined || policyTypes.includes('Ingress')
		return {
			kind: 'NetworkPolicy',
			name,
			selects: matchesLabelSelector(spec.podSelector, target.podLabels),
			enforcesIngress,
			// An `ingress` block under a `policyTypes` that leaves Ingress out
			// is ignored by the API server itself, so it neither covers nor
			// opens — it is not a rule of this cluster at all.
			rules: enforcesIngress
				? (rules ?? []).map((rule) => coreRuleVerdict(rule, target.agentPort))
				: [],
		}
	})
}

/** Every `CiliumNetworkPolicy` in the list, reduced the same way. */
export function readCiliumIngressPolicies(
	items: readonly unknown[],
	target: IngressVerificationTarget,
): IngressPolicyDocument[] {
	const identity = ciliumIdentityLabels(target.podLabels, target.namespace)
	const documents: IngressPolicyDocument[] = []
	for (const [index, item] of items.entries()) {
		const name = policyName(item, index)
		if (!isRecord(item)) {
			documents.push(
				unreadablePolicy('CiliumNetworkPolicy', name, 'a list entry that is not a policy object'),
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
				unreadablePolicy('CiliumNetworkPolicy', name, 'a specs that is not a list of rule specs'),
			)
			continue
		}
		for (const spec of more ?? []) specs.push(spec)
		if (specs.length === 0) {
			documents.push(
				unreadablePolicy('CiliumNetworkPolicy', name, 'neither a spec nor a specs list'),
			)
			continue
		}
		for (const spec of specs) {
			const document = readCiliumRuleSpec(spec, name, identity, target.agentPort)
			if (document !== undefined) documents.push(document)
		}
	}
	return documents
}

/** One `spec`/`specs` entry. `undefined` when it is node-scoped — see below. */
function readCiliumRuleSpec(
	spec: unknown,
	name: string,
	identity: Readonly<Record<string, string>>,
	agentPort: number,
): IngressPolicyDocument | undefined {
	const unreadable = (detail: string) => unreadablePolicy('CiliumNetworkPolicy', name, detail)
	if (!isRecord(spec)) return unreadable('a rule spec that is not an object')
	// A node-scoped rule selects nodes, never pods; it can neither cover nor
	// open a pod's port.
	if (spec.nodeSelector !== undefined) return undefined
	const rules = readList(spec.ingress)
	if (rules === 'unreadable') {
		return unreadable('a spec.ingress that is not a list of rules')
	}
	const ingressDeny = readList(spec.ingressDeny)
	if (ingressDeny === 'unreadable')
		return unreadable('a spec.ingressDeny that is not a list of rules')
	let enforcesIngress = rules !== undefined || ingressDeny !== undefined
	// Cilium 1.16 and later: `enableDefaultDeny.ingress: false` makes a rule
	// ALLOW without putting the endpoint into ingress default-deny, so it
	// closes nothing — the "looked like coverage and was not" shape of this
	// whole module, one CRD version later. Its own rules are still evaluated,
	// because what it admits it still admits; it simply cannot count as the
	// policy that covers the port.
	const enableDefaultDeny = spec.enableDefaultDeny
	if (enableDefaultDeny !== undefined) {
		if (!isRecord(enableDefaultDeny)) {
			return unreadable('an enableDefaultDeny that is not an object')
		}
		const forIngress = enableDefaultDeny.ingress
		if (forIngress !== undefined && typeof forIngress !== 'boolean') {
			return unreadable('an enableDefaultDeny.ingress that is not a boolean')
		}
		if (forIngress === false) enforcesIngress = false
	}
	return {
		kind: 'CiliumNetworkPolicy',
		name,
		selects: matchesLabelSelector(spec.endpointSelector, identity, ciliumSelectorKey),
		enforcesIngress,
		rules: (rules ?? []).map((rule) => ciliumRuleVerdict(rule, agentPort)),
	}
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface IngressDecision {
	readonly examined: readonly ExaminedIngressPolicy[]
	/** Absent when the port is covered and nothing opens it. */
	readonly refusal?: {
		readonly kind: IngressPolicyRefusal
		readonly summary: string
	}
}

/**
 * The union rule, applied. Pure — no I/O, no client, no clock — so every
 * shape that has to be refused can be asserted one per test, which is how
 * the "admits any peer" reading stays a rule rather than a heuristic.
 */
export function decideIngressCoverage(
	documents: readonly IngressPolicyDocument[],
	target: IngressVerificationTarget,
): IngressDecision {
	const examined: ExaminedIngressPolicy[] = []
	let covering = 0
	let open: ExaminedIngressPolicy | undefined
	let undecided: ExaminedIngressPolicy | undefined

	for (const document of documents) {
		const base = { kind: document.kind, name: document.name } as const
		if (document.unreadable !== undefined) {
			const entry: ExaminedIngressPolicy = {
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
			const entry: ExaminedIngressPolicy = {
				...base,
				verdict: 'not-evaluable',
				detail: 'its selector uses something this check cannot evaluate against pod labels',
			}
			examined.push(entry)
			undecided ??= entry
			continue
		}
		// Every RULE is read before the enforcement question is asked, because a
		// policy can admit a peer without default-denying anything — a Cilium
		// rule with `enableDefaultDeny.ingress: false` is exactly that, and what
		// it admits is admitted for real once something else default-denies the
		// endpoint. Both halves of reading a rule move together: a rule that
		// opens the port is the finding, and a rule nobody can read is a rule
		// that MIGHT open it, so neither may sit behind the enforcement gate. A
		// policy whose rules do not apply at all carries none of them, so this
		// asks nothing of those.
		const openRule = document.rules.find((rule) => rule.open === true)
		if (openRule !== undefined) {
			const entry: ExaminedIngressPolicy = {
				...base,
				verdict: 'opens-agent-port',
				...(openRule.detail !== undefined ? { detail: openRule.detail } : {}),
			}
			examined.push(entry)
			open ??= entry
			continue
		}
		const unknownRule = document.rules.find((rule) => rule.open === 'unknown')
		if (unknownRule !== undefined) {
			const entry: ExaminedIngressPolicy = {
				...base,
				verdict: 'not-evaluable',
				...(unknownRule.detail !== undefined ? { detail: unknownRule.detail } : {}),
			}
			examined.push(entry)
			undecided ??= entry
			continue
		}
		if (!document.enforcesIngress) {
			examined.push({
				...base,
				verdict: 'not-ingress-scoped',
				detail: 'it selects the pod but default-denies nothing on ingress',
			})
			continue
		}
		examined.push({ ...base, verdict: 'covers' })
		covering += 1
	}

	// Ordered by what an operator has to do first. A policy standing the door
	// open is the finding even when another one closes it, because the union
	// means the open one wins on the wire.
	if (open !== undefined) {
		return {
			examined,
			refusal: {
				kind: 'port-open',
				summary: `${open.kind}/${open.name} selects this pod and admits ${open.detail ?? `a wide-open peer on TCP ${target.agentPort}`}.`,
			},
		}
	}
	if (undecided !== undefined) {
		return {
			examined,
			refusal: {
				kind: 'not-evaluable',
				summary: `${undecided.kind}/${undecided.name} contains ${undecided.detail ?? 'something this check cannot evaluate'}, so whether the agent port is closed cannot be decided from the cluster's own objects.`,
			},
		}
	}
	if (covering === 0) {
		return {
			examined,
			refusal: {
				kind: 'no-covering-policy',
				summary:
					'no applied policy enforces ingress on this pod, so every pod in the cluster can reach its agent port.',
			},
		}
	}
	return { examined }
}

// ---------------------------------------------------------------------------
// The I/O half
// ---------------------------------------------------------------------------

/**
 * Internal: a collection that could not be enumerated. It carries what the
 * refusal needs and never escapes this module — {@link verifyIngressPolicyApplied}
 * turns it into a {@link KubernetesIngressPolicyError} that also reports
 * whatever WAS read before it.
 */
export class UnreadPolicyCollection extends Error {
	constructor(
		readonly source: UnreadPolicySource,
		readonly summary: string,
	) {
		super(summary)
	}
}

/**
 * Enumerate one policy collection, or report why it could not be read.
 *
 * Exported: `egress-policy.ts`'s union check lists exactly these two
 * collections for exactly this reason, and a second enumerator would be a
 * second answer to "which policies apply to this pod".
 */
export async function listPolicies(
	client: KubernetesClient,
	path: string,
	resource: UnreadPolicySource['resource'],
	signal?: AbortSignal,
): Promise<readonly unknown[]> {
	// No `limit` is sent, and the API server truncates a collection only when
	// one is — so this is the whole list, not a page of it. That matters more
	// here than anywhere else in this backend: a truncated list could hide the
	// one policy holding the port open.
	try {
		const list = await client.request<PolicyListResource>('GET', path, undefined, signal)
		return Array.isArray(list?.items) ? list.items : []
	} catch (err) {
		// A 404 on a COLLECTION means the resource itself is not served here.
		// For the CRD that is a declared engine the cluster does not have; for
		// core `networkpolicies`, which every API server serves, it is an
		// address that is not this cluster's. Either way the answer is "the
		// boundary could not be read", never "there are no policies".
		if (err instanceof KubernetesAlreadyGoneError) {
			throw new UnreadPolicyCollection(
				{
					resource,
					path,
					why: 'absent',
					reason: 'the API server served no such collection',
				},
				resource === 'ciliumnetworkpolicies'
					? `this backend is configured with ingress.engine: 'cilium' but the cluster serves no ${resource} resource at ${path}.`
					: `the cluster served no ${resource} collection at ${path}, which every Kubernetes API server is supposed to serve.`,
			)
		}
		if (err instanceof KubernetesCredentialError) {
			throw new UnreadPolicyCollection(
				{ resource, path, why: 'forbidden', reason: err.message },
				`the ServiceAccount this backend runs as may not 'list' ${resource} (${err.message}), so what the cluster admits on the agent port cannot be read.`,
			)
		}
		throw err
	}
}

/**
 * Verify-not-trust for ingress: list the namespace's policies, evaluate them
 * against the pod's real labels, and refuse unless the agent port is closed.
 *
 * Called BEFORE the POST on every path that creates a Sandbox, so a refusal
 * leaves no Sandbox and no PVC behind — and, on the claim path, after the
 * bind, where a refusal releases the claim through the acquire path's own
 * cleanup.
 */
export async function verifyIngressPolicyApplied(
	client: KubernetesClient,
	target: IngressVerificationTarget,
	signal?: AbortSignal,
): Promise<void> {
	const documents: IngressPolicyDocument[] = []
	try {
		documents.push(
			...readCoreIngressPolicies(
				await listPolicies(
					client,
					networkPolicyCollectionPath(target.namespace),
					'networkpolicies',
					signal,
				),
				target,
			),
		)
		if (target.engine === 'cilium') {
			documents.push(
				...readCiliumIngressPolicies(
					await listPolicies(
						client,
						ciliumNetworkPolicyCollectionPath(target.namespace),
						'ciliumnetworkpolicies',
						signal,
					),
					target,
				),
			)
		}
	} catch (err) {
		if (!(err instanceof UnreadPolicyCollection)) throw err
		// Whatever WAS read is still reported, with a verdict each: on the
		// cilium arm the core list has usually already been enumerated, and a
		// refusal that dropped it would tell the operator less than this
		// check actually knows. What it must not do is describe the list it
		// never got — hence `unread`.
		throw new KubernetesIngressPolicyError(
			'not-evaluable',
			target.subject,
			target.podLabels,
			target.agentPort,
			decideIngressCoverage(documents, target).examined,
			err.summary,
			[err.source],
		)
	}

	const decision = decideIngressCoverage(documents, target)
	if (decision.refusal === undefined) return
	throw new KubernetesIngressPolicyError(
		decision.refusal.kind,
		target.subject,
		target.podLabels,
		target.agentPort,
		decision.examined,
		decision.refusal.summary,
	)
}
