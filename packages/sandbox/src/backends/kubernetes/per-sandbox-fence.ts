/**
 * What the per-sandbox egress fence is checked FOR, and the operator-pinned
 * host set that tightens it.
 *
 * `per-sandbox-policy.ts` used to prove the fence by GETting the
 * `ValidatingAdmissionPolicy` and its binding and stopping at "the request
 * succeeded". An object that exists is not an object that fences: a binding
 * whose `validationActions` is `[Audit]` or `[Warn]` logs and admits, a
 * binding that names another policy attaches nothing to this one, a policy
 * with `failurePolicy: Ignore` admits whatever its expressions cannot
 * evaluate, a binding whose namespace selector excludes the sandboxes'
 * namespace never runs there, and a policy whose `matchConditions` name a
 * different user never matches this host. Each reads, from the outside,
 * exactly like an enforced fence, which is the failure the `no-network`
 * baseline's check exists to prevent for its own object: that one compares the
 * named object to the translation field by field, and refuses on any
 * difference.
 *
 * This module is the same standard applied to the fence. It reads what the
 * cluster stored and compares it, field by field, to what the writer relies
 * on, and refuses with a named error carrying the field that failed — before
 * anything is written.
 *
 * ## What it can and cannot prove
 *
 * It proves the CONFIGURATION of the fence: that the binding attaches this
 * policy, denies, fails closed, covers the namespace and the verbs, and that
 * the policy matches the configured identity. It does not evaluate the
 * policy's CEL: whether the shipped expressions refuse what they claim is
 * measured against an API server (see the header of
 * `validatingadmissionpolicy-cilium.yaml`), not derivable from the stored
 * object. The one exception is the companion policy below, whose expressions
 * this module owns and compares verbatim.
 *
 * ## The operator-pinned host set
 *
 * The shipped fence bounds the SHAPE of what a host may write, not the names:
 * any host holding the write verbs can grant any syntactically valid
 * `toFQDNs` entry. `config.egress.perSandbox.permittedHostsParam` names a
 * `ConfigMap` an operator maintains — the reviewed hostnames and ports — and
 * a COMPANION policy (`validatingadmissionpolicy-cilium-permitted-hosts.yaml`)
 * refuses, at admission, any `toFQDNs` name or port outside it. The backend
 * reads the same ConfigMap and refuses locally, with a precise error instead
 * of an opaque 403, but the admission rule stays the authority: the local
 * check is a courtesy and a second reader, never the boundary.
 *
 * A companion rather than a change to the shipped policy because the shipped
 * policy is already applied in clusters, and a host that does not configure
 * the parameter must see byte-for-byte what it saw before. The companion
 * covers CREATE and UPDATE only: a DELETE never widens, and a missing
 * parameter must not make `setNetworkPolicy([])` — the revoke — impossible.
 */

import { isDeepStrictEqual } from 'node:util'

import {
	type KubernetesPerSandboxEgressConfig,
	type KubernetesPermittedHostsParam,
	assertUsableHost,
} from './egress-policy.js'
import { isRecord, matchesLabelSelector, readList } from './ingress-policy.js'
import {
	KubernetesAlreadyGoneError,
	type KubernetesClient,
	KubernetesCredentialError,
} from './k8s-client.js'
import { configMapPath } from './objects.js'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The admission object a fence finding is about. */
export type FenceObjectKind = 'ValidatingAdmissionPolicy' | 'ValidatingAdmissionPolicyBinding'

/**
 * Raised when the fence EXISTS but would not enforce what this backend relies
 * on — `validationActions` without `Deny`, a binding that names another
 * policy, `failurePolicy: Ignore`, a namespace selector that leaves the
 * sandboxes' namespace out, a `matchConditions` that names another identity,
 * a companion policy whose expressions are not the ones this version ships,
 * or a binding whose parameter is not the configured one.
 *
 * Its own class rather than a reuse of
 * `KubernetesAdmissionFenceMissingError`, because the operator's action
 * differs: that error says to apply a manifest, this one says an applied
 * object is wrong and names the field. `field` is the dotted path inside
 * `resourceKind`, `expected` what the writer needs and `actual` what the
 * cluster holds.
 */
export class KubernetesAdmissionFenceInertError extends Error {
	override readonly name = 'KubernetesAdmissionFenceInertError'

	constructor(
		readonly resourceKind: FenceObjectKind,
		readonly objectName: string,
		readonly field: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(
			`kubernetes: config.egress.perSandbox is configured but the ${resourceKind} named ${objectName} would not fence what this host writes: ${field} is ${actual}, expected ${expected}. An applied admission object that does not enforce reads exactly like one that does, and the host holds create/patch/delete on every CiliumNetworkPolicy in the namespace, so nothing was written. Correct the object (the shipped k8s/manifests/validatingadmissionpolicy-cilium.yaml and validatingadmissionpolicy-cilium-permitted-hosts.yaml are the references) and call again.`,
		)
	}
}

/**
 * Raised when `permittedHostsParam` is configured and the ConfigMap it names
 * cannot be used: absent, unreadable, or not in the shape the companion
 * policy reads. Every `setNetworkPolicy` call that grants a host is refused
 * with it, and nothing is written.
 */
export class KubernetesPermittedHostsParamError extends Error {
	override readonly name = 'KubernetesPermittedHostsParamError'

	constructor(
		readonly param: KubernetesPermittedHostsParam,
		reason: string,
		cause?: unknown,
	) {
		super(
			`kubernetes: config.egress.perSandbox.permittedHostsParam names ConfigMap ${param.namespace}/${param.name}, which ${reason}. The admission policy that pins the permitted hosts reads the same object and denies every grant while it is missing or malformed, so this host refuses first, with nothing written. The expected shape is data.hosts (exact hostnames), data.patterns (*.domain patterns) and data.ports (numbers), each one entry per line; see k8s/manifests/validatingadmissionpolicy-cilium-permitted-hosts.yaml.`,
			cause === undefined ? undefined : { cause },
		)
	}
}

/**
 * Raised when a `setNetworkPolicy` call names a host or a port the
 * operator-pinned set does not contain. Local, named and before any write; the
 * admission policy would refuse the same body with an opaque 403.
 *
 * `hosts` are the `allowedHosts` entries as written; `ports` are the numbers
 * outside the set, and `unrestrictedPortsFor` the hosts whose rule carries no
 * port restriction at all — every port is outside any list.
 */
export class KubernetesPermittedHostsError extends Error {
	override readonly name = 'KubernetesPermittedHostsError'

	constructor(
		readonly param: KubernetesPermittedHostsParam,
		readonly hosts: readonly string[],
		readonly ports: readonly number[],
		readonly unrestrictedPortsFor: readonly string[],
	) {
		const parts: string[] = []
		if (hosts.length > 0) {
			parts.push(`the host(s) ${hosts.map((h) => JSON.stringify(h)).join(', ')} are not in it`)
		}
		if (ports.length > 0) {
			parts.push(`the port(s) ${ports.join(', ')} are not in it`)
		}
		if (unrestrictedPortsFor.length > 0) {
			parts.push(
				`${unrestrictedPortsFor.map((h) => JSON.stringify(h)).join(', ')} would be granted on EVERY port, because config.egress.perSandbox.narrowing sets no ports for it, and every port is outside any list (set narrowing.ports or narrowing.hostPorts)`,
			)
		}
		super(
			`kubernetes: refusing setNetworkPolicy: ConfigMap ${param.namespace}/${param.name} pins the hosts and ports this host may grant, and ${parts.join('; ')}. The shipped admission policy refuses the same body, so it would be a 403 after the fact. Nothing was written.`,
		)
	}
}

// ---------------------------------------------------------------------------
// Reading an admission object
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
	if (value === undefined) return 'absent'
	const text = JSON.stringify(value)
	return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** One expression, whitespace-collapsed — a folded YAML scalar and a one-liner compare equal. */
function normalizeExpression(value: unknown): string {
	return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

const CILIUM_GROUP = 'cilium.io'
const CILIUM_VERSION = 'v2'
const CILIUM_RESOURCE = 'ciliumnetworkpolicies'

/** The verbs of a `CiliumNetworkPolicy` write the shipped main policy covers. */
export const FENCE_OPERATIONS = ['CREATE', 'UPDATE', 'DELETE'] as const
/** The verbs the companion covers: a DELETE never widens, see the module header. */
export const COMPANION_OPERATIONS = ['CREATE', 'UPDATE'] as const

type Operation = 'CREATE' | 'UPDATE' | 'DELETE'

function listOf(value: unknown): readonly unknown[] | undefined {
	const read = readList(value)
	return read === 'unreadable' ? undefined : (read ?? [])
}

/** Does one admission `NamedRuleWithOperations` cover this operation on the CRD? */
function ruleCovers(rule: unknown, operation: Operation): boolean {
	if (!isRecord(rule)) return false
	const has = (field: string, wanted: string): boolean => {
		const list = listOf(rule[field])
		return list !== undefined && (list.includes(wanted) || list.includes('*'))
	}
	// A rule naming `resourceNames` narrows to those objects, which cannot
	// include the ones this host creates under names it generates.
	const names = listOf(rule.resourceNames)
	if (names === undefined || names.length > 0) return false
	return (
		has('apiGroups', CILIUM_GROUP) &&
		has('apiVersions', CILIUM_VERSION) &&
		has('resources', CILIUM_RESOURCE) &&
		has('operations', operation)
	)
}

/** Does any rule of the list cover the operation? `undefined` when the list is not a list. */
function rulesCover(rules: unknown, operation: Operation): boolean | undefined {
	const list = listOf(rules)
	if (list === undefined) return undefined
	return list.some((rule) => ruleCovers(rule, operation))
}

/**
 * `matchConstraints` (policy) / `matchResources` (binding): both are the same
 * `MatchResources` shape. Proves that, between them, the writes in
 * `operations` reach the validations — resource rules cover them, no exclude
 * rule removes them, and neither selector can be satisfied by an object the
 * host chooses the labels of.
 */
function assertMatchResources(
	kind: FenceObjectKind,
	objectName: string,
	path: 'spec.matchConstraints' | 'spec.matchResources',
	match: unknown,
	operations: readonly Operation[],
	namespace: string | undefined,
	/** A policy MUST state its resource rules; a binding may leave them to the policy. */
	rulesRequired: boolean,
): void {
	const fail = (field: string, expected: string, actual: unknown): never => {
		throw new KubernetesAdmissionFenceInertError(
			kind,
			objectName,
			`${path}.${field}`,
			expected,
			describe(actual),
		)
	}
	if (match === undefined || match === null) {
		if (rulesRequired)
			fail('resourceRules', 'rules covering cilium.io ciliumnetworkpolicies', match)
		return
	}
	if (!isRecord(match)) {
		throw new KubernetesAdmissionFenceInertError(
			kind,
			objectName,
			path,
			'an object',
			describe(match),
		)
	}
	if (match.resourceRules !== undefined || rulesRequired) {
		for (const operation of operations) {
			const covered = rulesCover(match.resourceRules, operation)
			if (covered !== true) {
				fail(
					'resourceRules',
					`a rule covering ${operation} of cilium.io/${CILIUM_VERSION} ${CILIUM_RESOURCE} (a binding that narrows the policy must still reach every write the host issues)`,
					match.resourceRules,
				)
			}
		}
	}
	const excluded = match.excludeResourceRules
	if (excluded !== undefined) {
		for (const operation of operations) {
			if (rulesCover(excluded, operation) !== false) {
				fail(
					'excludeResourceRules',
					`no rule excluding ${operation} of ${CILIUM_RESOURCE}`,
					excluded,
				)
			}
		}
	}
	// An object selector is matched against the OBJECT's labels, which the
	// writing host chooses: a fence that applies only to objects carrying a
	// label the host can simply leave off fences nothing.
	const objectSelector = match.objectSelector
	if (objectSelector !== undefined && objectSelector !== null) {
		const empty =
			isRecord(objectSelector) &&
			Object.keys(isRecord(objectSelector.matchLabels) ? objectSelector.matchLabels : {}).length ===
				0 &&
			(listOf(objectSelector.matchExpressions) ?? [null]).length === 0
		if (!empty)
			fail(
				'objectSelector',
				"absent or empty (the host chooses its objects' labels)",
				objectSelector,
			)
	}
	const namespaceSelector = match.namespaceSelector
	if (namespace !== undefined && namespaceSelector !== undefined && namespaceSelector !== null) {
		// Matched against the one label every namespace is guaranteed to carry.
		// A selector on any other label is not decidable from the stored
		// objects, and an unprovable fence is an unproven one.
		const verdict = matchesLabelSelector(namespaceSelector, {
			'kubernetes.io/metadata.name': namespace,
		})
		if (verdict !== 'yes') {
			fail(
				'namespaceSelector',
				`a selector that selects namespace ${namespace} (decided from the automatic kubernetes.io/metadata.name label, the only one this host can rely on; a selector on other labels is refused as unprovable)`,
				namespaceSelector,
			)
		}
	}
}

/** The conditions the host identity is checked against, when one is configured. */
function assertHostIdentity(
	policyName: string,
	policy: Record<string, unknown>,
	hostIdentity: string | undefined,
): void {
	if (hostIdentity === undefined) return
	const expected = `request.userInfo.username == '${hostIdentity}'`
	const conditions = listOf(policy.matchConditions)
	const names = (conditions ?? []).map((c) =>
		isRecord(c) ? normalizeExpression(c.expression) : '',
	)
	// Exactly that one condition: a second one can only narrow, and one that
	// narrows to nothing fences nothing.
	if (conditions === undefined || names.length !== 1 || names[0] !== expected) {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicy',
			policyName,
			'spec.matchConditions',
			`exactly one condition, ${expected}`,
			describe(names.length === 0 ? undefined : names),
		)
	}
}

function assertFailClosed(policyName: string, policy: Record<string, unknown>): void {
	if (policy.failurePolicy !== 'Fail') {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicy',
			policyName,
			'spec.failurePolicy',
			'"Fail" (an expression that errors must refuse the write, not admit it)',
			describe(policy.failurePolicy),
		)
	}
}

function specOf(
	kind: FenceObjectKind,
	objectName: string,
	object: unknown,
): Record<string, unknown> {
	const spec = isRecord(object) ? object.spec : undefined
	if (!isRecord(spec)) {
		throw new KubernetesAdmissionFenceInertError(
			kind,
			objectName,
			'spec',
			'an object',
			describe(spec),
		)
	}
	return spec
}

function assertBindingAttaches(
	bindingName: string,
	spec: Record<string, unknown>,
	policyName: string,
): void {
	if (spec.policyName !== policyName) {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicyBinding',
			bindingName,
			'spec.policyName',
			JSON.stringify(policyName),
			describe(spec.policyName),
		)
	}
	const actions = listOf(spec.validationActions)
	if (actions === undefined || !actions.includes('Deny')) {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicyBinding',
			bindingName,
			'spec.validationActions',
			'a list including "Deny" (Audit and Warn log and admit)',
			describe(spec.validationActions),
		)
	}
}

// ---------------------------------------------------------------------------
// The shipped fence
// ---------------------------------------------------------------------------

/** What the writer needs of the shipped main fence, read from the cluster. */
export interface FenceObjects {
	readonly policyName: string
	readonly policy: unknown
	readonly bindingName: string
	readonly binding: unknown
}

/**
 * The main fence: attached, denying, fail-closed, covering the namespace and
 * every verb the host issues, and — when configured — matching the host.
 */
export function assertFenceEnforces(
	fence: FenceObjects,
	namespace: string,
	perSandbox: Pick<KubernetesPerSandboxEgressConfig, 'hostIdentity'>,
): void {
	assertPolicyAndBinding(fence, namespace, FENCE_OPERATIONS, perSandbox.hostIdentity)
}

function assertPolicyAndBinding(
	fence: FenceObjects,
	namespace: string,
	operations: readonly Operation[],
	hostIdentity: string | undefined,
): { policy: Record<string, unknown>; binding: Record<string, unknown> } {
	const policy = specOf('ValidatingAdmissionPolicy', fence.policyName, fence.policy)
	assertFailClosed(fence.policyName, policy)
	assertMatchResources(
		'ValidatingAdmissionPolicy',
		fence.policyName,
		'spec.matchConstraints',
		policy.matchConstraints,
		operations,
		undefined,
		true,
	)
	const validations = listOf(policy.validations)
	if (validations === undefined || validations.length === 0) {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicy',
			fence.policyName,
			'spec.validations',
			'at least one validation (a policy with none validates nothing)',
			describe(policy.validations),
		)
	}
	assertHostIdentity(fence.policyName, policy, hostIdentity)

	const binding = specOf('ValidatingAdmissionPolicyBinding', fence.bindingName, fence.binding)
	assertBindingAttaches(fence.bindingName, binding, fence.policyName)
	assertMatchResources(
		'ValidatingAdmissionPolicyBinding',
		fence.bindingName,
		'spec.matchResources',
		binding.matchResources,
		operations,
		namespace,
		false,
	)
	return { policy, binding }
}

// ---------------------------------------------------------------------------
// The companion: the operator-pinned host set
// ---------------------------------------------------------------------------

/** The companion policy's name: the main policy's, with this appended. */
export const PERMITTED_HOSTS_POLICY_SUFFIX = '-hosts'

/**
 * The companion's names, derived rather than configured: one more name to
 * keep in step with an applied object is one more way for the check to read
 * the wrong object.
 */
export function permittedHostsFenceNames(perSandbox: KubernetesPerSandboxEgressConfig): {
	readonly policyName: string
	readonly bindingName: string
} {
	const policyName = `${perSandbox.admissionPolicyName}${PERMITTED_HOSTS_POLICY_SUFFIX}`
	return { policyName, bindingName: `${policyName}-binding` }
}

/** The companion's `spec.paramKind`. */
export const PERMITTED_HOSTS_PARAM_KIND = { apiVersion: 'v1', kind: 'ConfigMap' } as const

/**
 * The companion's variables and validation, VERBATIM. Owned here, compared
 * against the cluster's copy by {@link assertPermittedHostsFenceEnforces} and
 * against the shipped YAML by a test, so the three cannot drift: an applied
 * companion with an edited expression is a fence this backend cannot vouch
 * for, and is refused as one.
 *
 * Read as: every egress rule that carries `toFQDNs` must carry `toPorts`, every
 * port of which is in `data.ports`; and every `toFQDNs` entry is a `matchName`
 * in `data.hosts` or a `matchPattern` in `data.patterns`. Lists are
 * newline-separated strings because a ConfigMap holds strings; a key that is
 * missing makes the expression error, and `failurePolicy: Fail` makes an
 * error a refusal.
 */
export const PERMITTED_HOSTS_VARIABLES: readonly {
	readonly name: string
	readonly expression: string
}[] = [
	{
		name: 'egress',
		expression: 'has(object.spec) && has(object.spec.egress) ? object.spec.egress : []',
	},
	{ name: 'names', expression: "params.data.hosts.split('\\n')" },
	{ name: 'patterns', expression: "params.data.patterns.split('\\n')" },
	{ name: 'ports', expression: "params.data.ports.split('\\n')" },
]

export const PERMITTED_HOSTS_VALIDATIONS: readonly { readonly expression: string }[] = [
	{
		expression:
			'variables.egress.all(r, !has(r.toFQDNs) || (has(r.toPorts) && size(r.toPorts) > 0 && ' +
			'r.toPorts.all(p, has(p.ports) && size(p.ports) > 0 && ' +
			'p.ports.all(q, q.port in variables.ports)) && ' +
			'r.toFQDNs.all(f, (has(f.matchName) && f.matchName in variables.names) || ' +
			'(has(f.matchPattern) && f.matchPattern in variables.patterns))))',
	},
]

/**
 * The companion policy and its binding, compared to what this version ships.
 * Everything {@link assertFenceEnforces} proves for the main fence, over
 * CREATE and UPDATE, plus: the parameter kind, the variables and validation
 * verbatim, and a binding whose `paramRef` is THIS ConfigMap, by name, and
 * denies when it is missing — a binding with no parameter, or one that lets a
 * missing parameter through, pins nothing.
 */
export function assertPermittedHostsFenceEnforces(
	fence: FenceObjects,
	namespace: string,
	perSandbox: Pick<KubernetesPerSandboxEgressConfig, 'hostIdentity'>,
	param: KubernetesPermittedHostsParam,
): void {
	const { policy, binding } = assertPolicyAndBinding(
		fence,
		namespace,
		COMPANION_OPERATIONS,
		perSandbox.hostIdentity,
	)
	const policyFail = (field: string, expected: string, actual: unknown): never => {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicy',
			fence.policyName,
			field,
			expected,
			describe(actual),
		)
	}
	if (!isDeepStrictEqual(policy.paramKind, PERMITTED_HOSTS_PARAM_KIND)) {
		policyFail('spec.paramKind', describe(PERMITTED_HOSTS_PARAM_KIND), policy.paramKind)
	}
	const variables = (listOf(policy.variables) ?? []).map((v) =>
		isRecord(v) ? { name: v.name, expression: normalizeExpression(v.expression) } : v,
	)
	const expectedVariables = PERMITTED_HOSTS_VARIABLES.map((v) => ({
		name: v.name,
		expression: normalizeExpression(v.expression),
	}))
	if (!isDeepStrictEqual(variables, expectedVariables)) {
		policyFail('spec.variables', describe(expectedVariables), variables)
	}
	const validations = (listOf(policy.validations) ?? []).map((v) =>
		isRecord(v) ? { expression: normalizeExpression(v.expression) } : v,
	)
	const expectedValidations = PERMITTED_HOSTS_VALIDATIONS.map((v) => ({
		expression: normalizeExpression(v.expression),
	}))
	if (!isDeepStrictEqual(validations, expectedValidations)) {
		policyFail('spec.validations', describe(expectedValidations), validations)
	}

	const bindingFail = (field: string, expected: string, actual: unknown): never => {
		throw new KubernetesAdmissionFenceInertError(
			'ValidatingAdmissionPolicyBinding',
			fence.bindingName,
			field,
			expected,
			describe(actual),
		)
	}
	const paramRef = binding.paramRef
	if (!isRecord(paramRef)) {
		bindingFail(
			'spec.paramRef',
			`a reference to ConfigMap ${param.namespace}/${param.name} (a binding with no parameter pins no hosts)`,
			paramRef,
		)
		return
	}
	if (paramRef.name !== param.name) {
		bindingFail('spec.paramRef.name', JSON.stringify(param.name), paramRef.name)
	}
	if (paramRef.namespace !== param.namespace) {
		bindingFail('spec.paramRef.namespace', JSON.stringify(param.namespace), paramRef.namespace)
	}
	if (paramRef.selector !== undefined) {
		bindingFail(
			'spec.paramRef.selector',
			'absent (the parameter is named, not selected)',
			paramRef.selector,
		)
	}
	if (paramRef.parameterNotFoundAction !== 'Deny') {
		bindingFail(
			'spec.paramRef.parameterNotFoundAction',
			'"Deny" (an allow here admits every grant while the ConfigMap is missing)',
			paramRef.parameterNotFoundAction,
		)
	}
}

// ---------------------------------------------------------------------------
// The parameter, and the local check against it
// ---------------------------------------------------------------------------

/** The permitted set, as read from the ConfigMap. */
export interface PermittedHosts {
	readonly hosts: ReadonlySet<string>
	readonly patterns: ReadonlySet<string>
	readonly ports: ReadonlySet<number>
}

/**
 * Split one key into its entries. The admission policy splits the same string
 * on `\n` and compares entries byte for byte, so an entry with a stray space
 * or a `\r` would be accepted here and never match there; it is refused as
 * malformed instead. Empty lines are dropped, which is what lets a value end
 * in a newline.
 */
function entriesOf(
	param: KubernetesPermittedHostsParam,
	data: Record<string, unknown>,
	key: 'hosts' | 'patterns' | 'ports',
): readonly string[] {
	const value = data[key]
	if (typeof value !== 'string') {
		throw new KubernetesPermittedHostsParamError(
			param,
			`has no data.${key} string (found ${describe(value)}); the policy's expression reads it, so a missing key denies every grant`,
		)
	}
	const entries = value.split('\n').filter((line) => line !== '')
	for (const entry of entries) {
		if (entry.trim() !== entry) {
			throw new KubernetesPermittedHostsParamError(
				param,
				`has a data.${key} entry with surrounding whitespace or a carriage return (${JSON.stringify(entry)}); the policy compares entries byte for byte, so it would never match`,
			)
		}
	}
	return entries
}

/**
 * Parse the ConfigMap's `data`, with the same grammar the writer's hosts go
 * through ({@link assertUsableHost}), so a parameter cannot permit a name the
 * writer would refuse to emit.
 */
export function parsePermittedHosts(
	param: KubernetesPermittedHostsParam,
	configMap: unknown,
): PermittedHosts {
	const data = isRecord(configMap) ? configMap.data : undefined
	if (!isRecord(data)) {
		throw new KubernetesPermittedHostsParamError(param, 'has no data')
	}
	const bad = (what: string, entry: string, why: string): never => {
		throw new KubernetesPermittedHostsParamError(
			param,
			`lists ${what} ${JSON.stringify(entry)}, which ${why}`,
		)
	}
	const hosts = new Set<string>()
	for (const entry of entriesOf(param, data, 'hosts')) {
		if (entry.startsWith('.')) {
			bad(
				'host',
				entry,
				'is a domain entry; data.hosts holds exact names, and a domain is its name here plus a *.domain line in data.patterns',
			)
		}
		try {
			assertUsableHost(entry)
		} catch (err) {
			bad(
				'host',
				entry,
				`is not a usable hostname (${err instanceof Error ? err.message : String(err)})`,
			)
		}
		if (entry !== entry.toLowerCase())
			bad('host', entry, 'is not lowercase; Cilium compares the lowercase name a lookup returned')
		hosts.add(entry)
	}
	const patterns = new Set<string>()
	for (const entry of entriesOf(param, data, 'patterns')) {
		if (!entry.startsWith('*.')) bad('pattern', entry, 'is not of the form *.<domain>')
		const domain = entry.slice(2)
		try {
			assertUsableHost(`.${domain}`)
		} catch (err) {
			bad(
				'pattern',
				entry,
				`is not a usable domain pattern (${err instanceof Error ? err.message : String(err)})`,
			)
		}
		if (domain !== domain.toLowerCase()) bad('pattern', entry, 'is not lowercase')
		patterns.add(entry)
	}
	const ports = new Set<number>()
	for (const entry of entriesOf(param, data, 'ports')) {
		const port = Number(entry)
		if (!/^[1-9][0-9]{0,4}$/.test(entry) || port > 65535) {
			bad(
				'port',
				entry,
				'is not a port number (1 to 65535, written without a sign or leading zero)',
			)
		}
		ports.add(port)
	}
	return { hosts, patterns, ports }
}

/** GET and parse the parameter. A missing or unreadable ConfigMap refuses. */
export async function readPermittedHosts(
	client: KubernetesClient,
	param: KubernetesPermittedHostsParam,
	signal?: AbortSignal,
): Promise<PermittedHosts> {
	let configMap: unknown
	try {
		configMap = await client.request(
			'GET',
			configMapPath(param.namespace, param.name),
			undefined,
			signal,
		)
	} catch (err) {
		if (err instanceof KubernetesAlreadyGoneError) {
			throw new KubernetesPermittedHostsParamError(
				param,
				'does not exist, so the admission policy bound to it denies every grant',
			)
		}
		if (err instanceof KubernetesCredentialError) {
			throw new KubernetesPermittedHostsParamError(
				param,
				'cannot be read by this host (grant it get on that one ConfigMap; the companion manifest includes the Role)',
				err,
			)
		}
		throw err
	}
	return parsePermittedHosts(param, configMap)
}

/**
 * Refuse, locally, any host or port outside the permitted set. `hosts` are the
 * canonical `allowedHosts` entries and `portsFor` the port list the writer's
 * narrowing will emit for an entry (`undefined`: no restriction).
 *
 * A `.domain` entry becomes a `matchName` plus a `matchPattern`, and the
 * admission rule checks each against its own list, so both must be present.
 */
export function assertWithinPermittedHosts(
	param: KubernetesPermittedHostsParam,
	permitted: PermittedHosts,
	hosts: readonly string[],
	portsFor: (host: string) => readonly number[] | undefined,
): void {
	const outside: string[] = []
	const outsidePorts = new Set<number>()
	const unrestricted: string[] = []
	for (const host of hosts) {
		const exact = host.startsWith('.') ? host.slice(1) : host
		const allowed =
			permitted.hosts.has(exact) && (!host.startsWith('.') || permitted.patterns.has(`*.${exact}`))
		if (!allowed) outside.push(host)
		const ports = portsFor(host)
		if (ports === undefined) {
			unrestricted.push(host)
			continue
		}
		for (const port of ports) if (!permitted.ports.has(port)) outsidePorts.add(port)
	}
	if (outside.length > 0 || outsidePorts.size > 0 || unrestricted.length > 0) {
		throw new KubernetesPermittedHostsError(param, outside, [...outsidePorts], unrestricted)
	}
}
