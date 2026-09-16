/**
 * The agent port's ingress boundary, decided and then enforced.
 *
 * Two halves, deliberately separate:
 *
 *  - **The decision**, pure and one case per shape. The evaluator's whole
 *    risk is reading a legitimate narrow policy as wide open, or the
 *    reverse, so every shape that must open the port and every shape that
 *    must not gets its own assertion rather than being folded into one
 *    "realistic" fixture. The shipped `k8s/manifests/networkpolicy.yaml` is
 *    read off disk and run through the same evaluator, so the manifest an
 *    operator applies and the check that admits it cannot drift apart.
 *  - **The enforcement**, end to end against a real fake API server: that a
 *    create actually calls it, on every path, at a moment where a refusal
 *    leaves nothing behind.
 *
 * What this suite CANNOT prove, and no test in this repository can, is that a
 * cluster enforces the policy it accepted. That is a CNI property; the local
 * kind test bed's default CNI does not enforce `NetworkPolicy` at all, so a
 * "the port is closed" probe there passes for the wrong reason.
 * `k8s/scripts/ingress-check.mjs` is the live check, and it ships a positive
 * control precisely so a non-enforcing cluster fails loudly instead of
 * reporting a pass.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

import {
	type IngressVerificationTarget,
	KubernetesIngressPolicyError,
	decideIngressCoverage,
	readCiliumIngressPolicies,
	readCoreIngressPolicies,
	resolveIngressEngine,
} from '../ingress-policy.js'

import { buildKubernetesBackend } from '../index.js'
import { SANDBOX_TEMPLATE_LABEL_KEY } from '../objects.js'
import { createKubernetesWorkspace } from '../workspace.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const AGENT_PORT = 1024
const TASK_TEMPLATE = 'namzu-task'
const WORKSPACE_TEMPLATE = 'namzu-workspace'
const WORKSPACE_ID = 'acme-checkout-7'
const WORKSPACE_NAME = 'namzu-ws-acme-checkout-7'
const POOL_SANDBOX_NAME = 'ingress-pool-sandbox-1'
const POD_UID = '2b8f0f41-9d1a-4a0e-9a1e-1f1d9e2c7a31'

const POD_LABELS = {
	[SANDBOX_TEMPLATE_LABEL_KEY]: TASK_TEMPLATE,
	'app.kubernetes.io/part-of': 'namzu',
}

function target(overrides: Partial<IngressVerificationTarget> = {}): IngressVerificationTarget {
	return {
		namespace: NAMESPACE,
		podLabels: POD_LABELS,
		agentPort: AGENT_PORT,
		engine: 'core',
		subject: 'Sandbox under test',
		...overrides,
	}
}

/** The shipped baseline's shape, with the port a case actually uses. */
function baselineCorePolicy(port = AGENT_PORT, name = 'namzu-sandbox-baseline') {
	return {
		metadata: { name },
		spec: {
			podSelector: {
				matchExpressions: [{ key: SANDBOX_TEMPLATE_LABEL_KEY, operator: 'Exists' }],
			},
			policyTypes: ['Ingress', 'Egress'],
			ingress: [
				{
					from: [{ podSelector: { matchLabels: { 'namzu.ai/component': 'host' } } }],
					ports: [{ protocol: 'TCP', port }],
				},
			],
		},
	}
}

function decideCore(policies: unknown[], overrides: Partial<IngressVerificationTarget> = {}) {
	const resolved = target(overrides)
	return decideIngressCoverage(
		readCoreIngressPolicies(policies as Parameters<typeof readCoreIngressPolicies>[0], resolved),
		resolved,
	)
}

function decideCilium(policies: unknown[], overrides: Partial<IngressVerificationTarget> = {}) {
	const resolved = target({ engine: 'cilium', ...overrides })
	return decideIngressCoverage(
		readCiliumIngressPolicies(
			policies as Parameters<typeof readCiliumIngressPolicies>[0],
			resolved,
		),
		resolved,
	)
}

describe('the shipped manifest is the fixture', () => {
	const HERE = dirname(fileURLToPath(import.meta.url))
	const MANIFEST = join(HERE, '../../../../k8s/manifests/networkpolicy.yaml')

	it('k8s/manifests/networkpolicy.yaml, as applied, covers a sandbox pod on the agent port', () => {
		const docs = parseAllDocuments(readFileSync(MANIFEST, 'utf8')).map((doc) => doc.toJS())
		expect(docs).toHaveLength(1)
		const decision = decideCore(docs)
		expect(decision.refusal).toBeUndefined()
		expect(decision.examined).toEqual([
			{ kind: 'NetworkPolicy', name: 'namzu-sandbox-baseline', verdict: 'covers' },
		])
	})

	it('and covers a WORKSPACE pod too — it selects the template label by existence, not by value', () => {
		const docs = parseAllDocuments(readFileSync(MANIFEST, 'utf8')).map((doc) => doc.toJS())
		const decision = decideCore(docs, {
			podLabels: { [SANDBOX_TEMPLATE_LABEL_KEY]: WORKSPACE_TEMPLATE },
		})
		expect(decision.refusal).toBeUndefined()
	})

	it('and does NOT cover a pod that carries no template label at all', () => {
		const docs = parseAllDocuments(readFileSync(MANIFEST, 'utf8')).map((doc) => doc.toJS())
		const decision = decideCore(docs, { podLabels: { app: 'something-else' } })
		expect(decision.refusal?.kind).toBe('no-covering-policy')
		expect(decision.examined[0]?.verdict).toBe('does-not-select')
	})
})

describe('coverage', () => {
	it('refuses when the namespace holds no policy at all', () => {
		const decision = decideCore([])
		expect(decision.refusal?.kind).toBe('no-covering-policy')
		expect(decision.examined).toEqual([])
	})

	it('refuses when every policy in the namespace selects some other pod', () => {
		const decision = decideCore([
			{
				metadata: { name: 'other-workload' },
				spec: {
					podSelector: { matchLabels: { app: 'billing' } },
					policyTypes: ['Ingress'],
					ingress: [],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('no-covering-policy')
	})

	it('refuses a policy that selects the pod but leaves Ingress out of policyTypes', () => {
		const decision = decideCore([
			{
				metadata: { name: 'egress-only' },
				spec: {
					podSelector: {},
					policyTypes: ['Egress'],
					// Present, and enforcing nothing: without 'Ingress' in
					// policyTypes the API server ignores this array entirely.
					ingress: [{ from: [{ podSelector: { matchLabels: { role: 'host' } } }] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('no-covering-policy')
		expect(decision.examined[0]?.verdict).toBe('not-ingress-scoped')
	})

	it('accepts a deny-everything policy: an empty ingress list closes every port', () => {
		const decision = decideCore([
			{
				metadata: { name: 'deny-all-ingress' },
				spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('treats an absent policyTypes as enforcing ingress, because the API server defaults it that way', () => {
		const decision = decideCore([{ metadata: { name: 'defaulted' }, spec: { podSelector: {} } }])
		expect(decision.refusal).toBeUndefined()
	})
})

describe('one open rule opens the port, whatever sits beside it', () => {
	it('refuses when a SECOND policy selecting the pod has an ingress rule with no from', () => {
		const decision = decideCore([
			baselineCorePolicy(),
			{
				metadata: { name: 'debug-access' },
				spec: {
					podSelector: { matchLabels: { [SANDBOX_TEMPLATE_LABEL_KEY]: TASK_TEMPLATE } },
					policyTypes: ['Ingress'],
					ingress: [{ ports: [{ protocol: 'TCP', port: AGENT_PORT }] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
		expect(decision.refusal?.summary).toContain('debug-access')
		// The closed one is still reported, so an operator sees which policy
		// they thought was protecting them.
		expect(decision.examined.map((p) => p.verdict)).toEqual(['covers', 'opens-agent-port'])
	})

	it.each([
		['an empty from list', { from: [], ports: [{ protocol: 'TCP', port: AGENT_PORT }] }],
		[
			'a namespaceSelector: {} peer',
			{
				from: [{ namespaceSelector: {} }],
				ports: [{ protocol: 'TCP', port: AGENT_PORT }],
			},
		],
		[
			'an ipBlock 0.0.0.0/0 peer',
			{
				from: [{ ipBlock: { cidr: '0.0.0.0/0' } }],
				ports: [{ protocol: 'TCP', port: AGENT_PORT }],
			},
		],
		[
			'an ipBlock ::/0 peer',
			{ from: [{ ipBlock: { cidr: '::/0' } }], ports: [{ protocol: 'TCP', port: AGENT_PORT }] },
		],
		[
			'an ipBlock 0.0.0.0/0 peer with an except list that still admits the rest of the internet',
			{
				from: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8'] } }],
				ports: [{ protocol: 'TCP', port: AGENT_PORT }],
			},
		],
		['no ports at all, so every port', { from: [{ namespaceSelector: {} }] }],
	])('refuses a core rule with %s', (_name, rule) => {
		const decision = decideCore([
			{
				metadata: { name: 'too-open' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [rule],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})

	it.each(['all', 'cluster', 'world'])(
		'refuses a Cilium rule whose fromEntities includes %s',
		(entity) => {
			const decision = decideCilium([
				{
					metadata: { name: 'entity-open' },
					spec: {
						endpointSelector: {
							matchLabels: { [`k8s:${SANDBOX_TEMPLATE_LABEL_KEY}`]: TASK_TEMPLATE },
						},
						ingress: [
							{
								fromEntities: [entity],
								toPorts: [{ ports: [{ port: String(AGENT_PORT), protocol: 'TCP' }] }],
							},
						],
					},
				},
			])
			expect(decision.refusal?.kind).toBe('port-open')
		},
	)

	it('refuses a Cilium rule that names ports and no source at all', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'port-only' },
				spec: {
					endpointSelector: {},
					ingress: [{ toPorts: [{ ports: [{ port: String(AGENT_PORT), protocol: 'TCP' }] }] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})

	it('refuses a Cilium rule reaching the port through fromCIDR 0.0.0.0/0', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'cidr-open' },
				spec: { endpointSelector: {}, ingress: [{ fromCIDR: ['0.0.0.0/0'] }] },
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})

	it('reads a Cilium policy declared under `specs`, not only under `spec`', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'multi-spec' },
				specs: [
					{ endpointSelector: {}, ingress: [] },
					{ endpointSelector: {}, ingress: [{ fromEntities: ['world'] }] },
				],
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})
})

describe('narrow rules stay narrow', () => {
	it.each([
		[
			'a podSelector peer naming the host',
			{ from: [{ podSelector: { matchLabels: { 'namzu.ai/component': 'host' } } }] },
		],
		[
			'a namespaceSelector: {} paired with a real podSelector',
			{
				from: [
					{ namespaceSelector: {}, podSelector: { matchLabels: { 'namzu.ai/component': 'host' } } },
				],
			},
		],
		['an ipBlock naming one host range', { from: [{ ipBlock: { cidr: '10.42.7.0/24' } }] }],
		[
			'a bare podSelector: {} — every pod in this namespace, which is broad and is still a constraint',
			{ from: [{ podSelector: {} }] },
		],
	])('accepts %s', (_name, rule) => {
		const decision = decideCore([
			{
				metadata: { name: 'narrow' },
				spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [rule] },
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('accepts a Cilium rule whose fromEntities names only host and remote-node', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'node-only' },
				spec: {
					endpointSelector: {},
					ingress: [{ fromEntities: ['host', 'remote-node'] }],
				},
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('ignores a Cilium rule that selects NODES rather than pods', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'node-scoped' },
				spec: { nodeSelector: {}, ingress: [{ fromEntities: ['world'] }] },
			},
		])
		// It cannot open a pod's port, and it cannot close one either.
		expect(decision.refusal?.kind).toBe('no-covering-policy')
	})
})

describe('a rule about another port is a rule about another port', () => {
	it('a wide-open rule on a DIFFERENT port does not open the agent port', () => {
		const decision = decideCore([
			{
				metadata: { name: 'metrics' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [
						{ from: [{ namespaceSelector: {} }], ports: [{ protocol: 'TCP', port: 9090 }] },
					],
				},
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('a UDP rule on the agent port number does not open the TCP agent port', () => {
		const decision = decideCore([
			{
				metadata: { name: 'udp-only' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [{ from: [], ports: [{ protocol: 'UDP', port: AGENT_PORT }] }],
				},
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('a rule whose endPort range spans the agent port DOES open it', () => {
		const decision = decideCore([
			{
				metadata: { name: 'range' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [{ from: [], ports: [{ protocol: 'TCP', port: 1000, endPort: 2000 }] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})

	// DEVIATION, recorded on purpose. The plan for this issue says a policy
	// whose `ports` do not include the agent port "does not count as coverage
	// and does not count as an opening". The second half is the test above;
	// the first half is not implementable without refusing the safest policy
	// there is — `policyTypes: [Ingress]` with an empty or unrelated rule list
	// is the canonical deny-all, and it closes the agent port precisely BY not
	// mentioning it. Coverage is therefore "an ingress-enforcing policy
	// selects this pod", which is the resource's own semantics, and the rule
	// about ports lives where it belongs: in what counts as an opening.
	it('such a policy still COVERS the pod, because selecting it is what default-denies the agent port', () => {
		const decision = decideCore([
			{
				metadata: { name: 'metrics' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [
						{ from: [{ namespaceSelector: {} }], ports: [{ protocol: 'TCP', port: 9090 }] },
					],
				},
			},
		])
		expect(decision.examined[0]?.verdict).toBe('covers')
	})
})

describe('what it will not guess at', () => {
	it('refuses a named port it cannot resolve, rather than assuming either way', () => {
		const decision = decideCore([
			{
				metadata: { name: 'named-port' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [{ from: [], ports: [{ protocol: 'TCP', port: 'agent' }] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('not-evaluable')
		expect(decision.refusal?.summary).toContain('named-port')
	})

	it('accepts a numeric STRING port, which is the same number written differently', () => {
		const decision = decideCore([
			{
				metadata: { name: 'string-port' },
				spec: {
					podSelector: {},
					policyTypes: ['Ingress'],
					ingress: [{ from: [], ports: [{ protocol: 'TCP', port: '9090' }] }],
				},
			},
		])
		expect(decision.refusal).toBeUndefined()
	})

	it('refuses a selector operator it does not implement', () => {
		const decision = decideCore([
			{
				metadata: { name: 'exotic' },
				spec: {
					podSelector: {
						matchExpressions: [{ key: 'tier', operator: 'GreaterThan', values: ['2'] }],
					},
					policyTypes: ['Ingress'],
					ingress: [],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('not-evaluable')
	})

	it('refuses a Cilium selector keyed by a label SOURCE it cannot map onto a pod label', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'reserved-source' },
				spec: {
					endpointSelector: { matchLabels: { 'reserved:init': '' } },
					ingress: [{ fromEntities: ['world'] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('not-evaluable')
	})

	it('reports the port-open finding first when a policy is both open and one is undecidable', () => {
		const decision = decideCore([
			{
				metadata: { name: 'undecidable' },
				spec: {
					podSelector: { matchExpressions: [{ key: 'tier', operator: 'GreaterThan' }] },
					policyTypes: ['Ingress'],
					ingress: [],
				},
			},
			{
				metadata: { name: 'wide-open' },
				spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [] }] },
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})
})

// ---------------------------------------------------------------------------
// The wire, read defensively. One case per shape the module's own contract
// names, because the failure mode here is silent and one-directional: a field
// that cannot be read, read as a pass, reports the agent port closed on the
// strength of something nobody could parse. Every case below must land on
// `not-evaluable`, never on `covers` and never on a throw.
// ---------------------------------------------------------------------------

describe('a field it cannot read is never read as a pass', () => {
	/** The verdict of the single policy in the list, whatever it turned out to be. */
	const coreVerdict = (policy: unknown) => decideCore([policy]).examined[0]?.verdict
	const ciliumVerdict = (policy: unknown) => decideCilium([policy]).examined[0]?.verdict

	it('refuses a spec.ingress that is not a list of rules, rather than reading it as no rules', () => {
		// The shape that regressed: `ingress` substituted with an empty list
		// made this policy `covers`, so a create passed on a field the check
		// could not read.
		const decision = decideCore([
			{
				metadata: { name: 'weird' },
				spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: { from: [] } },
			},
		])
		expect(decision.examined[0]?.verdict).toBe('not-evaluable')
		expect(decision.examined[0]?.detail).toContain('spec.ingress')
		expect(decision.refusal?.kind).toBe('not-evaluable')
	})

	it('refuses a list entry, a spec or a policyTypes of the wrong shape', () => {
		expect(coreVerdict('not-a-policy')).toBe('not-evaluable')
		expect(coreVerdict(null)).toBe('not-evaluable')
		expect(coreVerdict({ metadata: { name: 'no-spec' } })).toBe('not-evaluable')
		expect(coreVerdict({ metadata: { name: 'spec-is-a-list' }, spec: [] })).toBe('not-evaluable')
		expect(
			coreVerdict({
				metadata: { name: 'types' },
				spec: { podSelector: {}, policyTypes: 'Ingress', ingress: [] },
			}),
		).toBe('not-evaluable')
	})

	it('refuses a podSelector that is not a selector, rather than letting it select everything', () => {
		// An empty selector DOES select everything — that is the resource's
		// own rule — so an unreadable one must not take the same path.
		const wrap = (podSelector: unknown) => ({
			metadata: { name: 'selector' },
			spec: { podSelector, policyTypes: ['Ingress'], ingress: [] },
		})
		expect(coreVerdict(wrap('everything'))).toBe('not-evaluable')
		expect(coreVerdict(wrap([]))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ matchLabels: 'app=billing' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ matchLabels: { app: 7 } }))).toBe('not-evaluable')
		// A non-array matchExpressions used to be ITERATED, which threw a
		// TypeError out of a create path rather than refusing it.
		expect(() =>
			coreVerdict(wrap({ matchExpressions: { key: 'a', operator: 'Exists' } })),
		).not.toThrow()
		expect(coreVerdict(wrap({ matchExpressions: { key: 'a', operator: 'Exists' } }))).toBe(
			'not-evaluable',
		)
	})

	it('refuses an In or NotIn whose values it cannot read, rather than treating them as none', () => {
		// `values: 'a'` read as the empty list answers NotIn with "matches",
		// so the pod counted as selected — coverage from an unread field.
		const wrap = (expression: unknown) => ({
			metadata: { name: 'expr' },
			spec: {
				podSelector: { matchExpressions: [expression] },
				policyTypes: ['Ingress'],
				ingress: [],
			},
		})
		expect(coreVerdict(wrap({ key: 'absent', operator: 'NotIn', values: 'a' }))).toBe(
			'not-evaluable',
		)
		expect(coreVerdict(wrap({ key: 'absent', operator: 'NotIn' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ key: SANDBOX_TEMPLATE_LABEL_KEY, operator: 'In', values: {} }))).toBe(
			'not-evaluable',
		)
		expect(coreVerdict(wrap('not-an-expression'))).toBe('not-evaluable')
	})

	it('refuses a ports or a from of the wrong shape on an ingress rule', () => {
		const wrap = (rule: unknown) => ({
			metadata: { name: 'rule' },
			spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [rule] },
		})
		expect(coreVerdict(wrap({ from: [], ports: 'tcp/1024' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ from: [], ports: ['1024'] }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ from: [], ports: [{ protocol: 6, port: AGENT_PORT }] }))).toBe(
			'not-evaluable',
		)
		expect(
			coreVerdict(wrap({ from: [], ports: [{ protocol: 'TCP', port: 1000, endPort: 'many' }] })),
		).toBe('not-evaluable')
		// An absent `from` means every source; a `from` that is present as
		// something else means nothing at all, and says so.
		expect(coreVerdict(wrap({ from: { podSelector: {} } }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ from: ['everyone'] }))).toBe('not-evaluable')
	})

	it('refuses a peer whose ipBlock or selector it cannot read, rather than calling it wide open', () => {
		const wrap = (peer: unknown) => ({
			metadata: { name: 'peer' },
			spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [peer] }] },
		})
		// Each of these used to reach a verdict: the first two by reading an
		// unreadable selector as the empty (= everything) one, which named a
		// policy as the thing holding the door open on no evidence.
		expect(coreVerdict(wrap({ namespaceSelector: 'all' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ namespaceSelector: {}, podSelector: 'all' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ ipBlock: '0.0.0.0/0' }))).toBe('not-evaluable')
		expect(coreVerdict(wrap({ ipBlock: { cidr: 0 } }))).toBe('not-evaluable')
	})

	it('refuses a Cilium spec, specs or ingress of the wrong shape', () => {
		expect(ciliumVerdict({ metadata: { name: 'no-spec' } })).toBe('not-evaluable')
		expect(ciliumVerdict({ metadata: { name: 'specs' }, specs: 'one' })).toBe('not-evaluable')
		expect(ciliumVerdict({ metadata: { name: 'spec' }, spec: 'one' })).toBe('not-evaluable')
		expect(
			ciliumVerdict({
				metadata: { name: 'ingress' },
				spec: { endpointSelector: {}, ingress: { fromEntities: ['host'] } },
			}),
		).toBe('not-evaluable')
		expect(
			ciliumVerdict({
				metadata: { name: 'deny' },
				spec: { endpointSelector: {}, ingressDeny: 'all' },
			}),
		).toBe('not-evaluable')
	})

	it('refuses a Cilium toPorts it cannot read, and does not throw on a non-string protocol', () => {
		const wrap = (rule: unknown) => ({
			metadata: { name: 'ports' },
			spec: { endpointSelector: {}, ingress: [rule] },
		})
		expect(ciliumVerdict(wrap({ fromEntities: ['host'], toPorts: 'tcp' }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromEntities: ['host'], toPorts: ['1024'] }))).toBe('not-evaluable')
		expect(
			ciliumVerdict(wrap({ fromEntities: ['host'], toPorts: [{ ports: { port: '1024' } }] })),
		).toBe('not-evaluable')
		// `(6).toUpperCase()` is a TypeError, and it used to escape a create.
		const numericProtocol = wrap({
			fromEntities: ['host'],
			toPorts: [{ ports: [{ protocol: 6, port: `${AGENT_PORT}` }] }],
		})
		expect(() => ciliumVerdict(numericProtocol)).not.toThrow()
		expect(ciliumVerdict(numericProtocol)).toBe('not-evaluable')
	})

	it('refuses a Cilium source field that is not a list, rather than ignoring it', () => {
		// The permissive shape: a rule with one readable narrow source and one
		// unreadable field read as narrow overall, so the policy covered.
		const decision = decideCilium([
			{
				metadata: { name: 'mixed' },
				spec: {
					endpointSelector: {},
					ingress: [
						{
							fromEndpoints: [{ matchLabels: { 'namzu.ai/component': 'host' } }],
							fromCIDR: '0.0.0.0/0',
							toPorts: [{ ports: [{ protocol: 'TCP', port: `${AGENT_PORT}` }] }],
						},
					],
				},
			},
		])
		expect(decision.examined[0]?.verdict).toBe('not-evaluable')
		expect(decision.examined[0]?.detail).toContain('fromCIDR')
		const wrap = (rule: unknown) => ({
			metadata: { name: 'source' },
			spec: { endpointSelector: {}, ingress: [rule] },
		})
		expect(ciliumVerdict(wrap({ fromEntities: 'world' }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromEntities: [7] }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromCIDR: [7] }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromCIDRSet: ['10.0.0.0/8'] }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromEndpoints: ['host'] }))).toBe('not-evaluable')
	})

	it('does not count a Cilium rule that switches its own default-deny off as coverage', () => {
		// Cilium 1.16's `enableDefaultDeny`. Such a rule ALLOWS without
		// isolating the endpoint, so it closes nothing — the shape this whole
		// module exists for, one CRD version later.
		const narrow = {
			fromEndpoints: [{ matchLabels: { 'namzu.ai/component': 'host' } }],
			toPorts: [{ ports: [{ protocol: 'TCP', port: `${AGENT_PORT}` }] }],
		}
		const decision = decideCilium([
			{
				metadata: { name: 'allow-only' },
				spec: {
					endpointSelector: {},
					enableDefaultDeny: { ingress: false },
					ingress: [narrow],
				},
			},
		])
		expect(decision.examined[0]?.verdict).toBe('not-ingress-scoped')
		expect(decision.refusal?.kind).toBe('no-covering-policy')
		// The same policy WOULD cover without that field, which is what makes
		// the case above about the field rather than about the rule.
		expect(
			decideCilium([
				{ metadata: { name: 'allow-only' }, spec: { endpointSelector: {}, ingress: [narrow] } },
			]).refusal,
		).toBeUndefined()
	})

	it('still reports what a default-deny-less Cilium rule ADMITS, because it admits it', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'open-allow' },
				spec: {
					endpointSelector: {},
					enableDefaultDeny: { ingress: false },
					ingress: [{ fromEntities: ['world'] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})

	it('refuses a rule it cannot read inside a policy that switched its own default-deny off', () => {
		// The other half of the same gate. Such a policy still ALLOWS, so a
		// rule nobody can read there is a rule that MIGHT open the agent port,
		// and reading it as "selects the pod but default-denies anything" would
		// pass the create on a field this check never parsed. A NAMED port is
		// the schema-valid way to write one: the CRD takes it, and this check
		// has no pod spec to resolve it against.
		const named = {
			fromEntities: ['world'],
			toPorts: [{ ports: [{ protocol: 'TCP', port: 'agent' }] }],
		}
		const wrap = (rule: unknown) => ({
			metadata: { name: 'no-deny-unreadable' },
			spec: {
				endpointSelector: {},
				enableDefaultDeny: { ingress: false },
				ingress: [rule],
			},
		})
		const decision = decideCilium([wrap(named)])
		expect(decision.examined[0]?.verdict).toBe('not-evaluable')
		expect(decision.examined[0]?.detail).toContain('toPorts')
		expect(decision.refusal?.kind).toBe('not-evaluable')
		// Every other unreadable rule shape under the same field, which used
		// to land on `not-ingress-scoped` and let the create through.
		expect(ciliumVerdict(wrap({ toPorts: 'not-a-list' }))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap('nonsense'))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ fromEntities: 'world', toPorts: [{}] }))).toBe('not-evaluable')
		// It is the rule that is undecidable and not the field: the same rule
		// written with a port this check CAN read is still the open finding,
		// and a policy with nothing undecidable in it is still not coverage.
		expect(
			ciliumVerdict(
				wrap({ fromEntities: ['world'], toPorts: [{ ports: [{ port: `${AGENT_PORT}` }] }] }),
			),
		).toBe('opens-agent-port')
		expect(ciliumVerdict(wrap({ fromEndpoints: [{ matchLabels: { app: 'host' } }] }))).toBe(
			'not-ingress-scoped',
		)
	})

	it('refuses an enableDefaultDeny it cannot read', () => {
		const wrap = (enableDefaultDeny: unknown) => ({
			metadata: { name: 'default-deny' },
			spec: { endpointSelector: {}, enableDefaultDeny, ingress: [] },
		})
		expect(ciliumVerdict(wrap('off'))).toBe('not-evaluable')
		expect(ciliumVerdict(wrap({ ingress: 'false' }))).toBe('not-evaluable')
		// Its explicit `true` is the CRD's own default and changes nothing.
		expect(ciliumVerdict(wrap({ ingress: true }))).toBe('covers')
	})

	it('leaves the ingress block of a policy the API server ignores out of the finding', () => {
		// `policyTypes: ['Egress']` makes the API server ignore the ingress
		// block entirely, so a wide-open rule inside it is not a rule of this
		// cluster and must not be reported as one.
		const decision = decideCore([
			{
				metadata: { name: 'egress-only' },
				spec: { podSelector: {}, policyTypes: ['Egress'], ingress: [{ from: [] }] },
			},
		])
		expect(decision.examined[0]?.verdict).toBe('not-ingress-scoped')
		expect(decision.refusal?.kind).toBe('no-covering-policy')
	})
})

describe('label matching', () => {
	const selects = (podSelector: unknown): boolean => {
		const decision = decideCore([
			{ metadata: { name: 'p' }, spec: { podSelector, policyTypes: ['Ingress'], ingress: [] } },
		])
		return decision.examined[0]?.verdict === 'covers'
	}

	it('matches In, NotIn, Exists and DoesNotExist the way the API defines them', () => {
		expect(selects({ matchLabels: { [SANDBOX_TEMPLATE_LABEL_KEY]: TASK_TEMPLATE } })).toBe(true)
		expect(selects({ matchLabels: { [SANDBOX_TEMPLATE_LABEL_KEY]: 'other' } })).toBe(false)
		expect(
			selects({ matchExpressions: [{ key: SANDBOX_TEMPLATE_LABEL_KEY, operator: 'Exists' }] }),
		).toBe(true)
		expect(selects({ matchExpressions: [{ key: 'nope', operator: 'DoesNotExist' }] })).toBe(true)
		expect(
			selects({
				matchExpressions: [
					{ key: SANDBOX_TEMPLATE_LABEL_KEY, operator: 'In', values: ['namzu-task', 'x'] },
				],
			}),
		).toBe(true)
		// NotIn is satisfied by a pod that does not carry the key at all —
		// the API's own rule, and the opposite of the intuitive reading.
		expect(
			selects({ matchExpressions: [{ key: 'absent', operator: 'NotIn', values: ['a'] }] }),
		).toBe(true)
	})

	it("reads the pod's own labels only, never a member the label object inherits", () => {
		// `constructor` is a legal label key, and a plain-object lookup answers
		// it off the prototype. A pod that carries no such label would then be
		// reported as SELECTED by this policy — counting as coverage it does not
		// give, or, on a rule with a wide-open source, as an opening it is not.
		expect(selects({ matchExpressions: [{ key: 'constructor', operator: 'Exists' }] })).toBe(false)
		expect(selects({ matchExpressions: [{ key: 'toString', operator: 'DoesNotExist' }] })).toBe(
			true,
		)
	})

	it('matches a Cilium selector on the namespace identity label', () => {
		const decision = decideCilium([
			{
				metadata: { name: 'ns-scoped' },
				spec: {
					endpointSelector: {
						matchLabels: { 'k8s:io.kubernetes.pod.namespace': NAMESPACE },
					},
					ingress: [{ fromEntities: ['world'] }],
				},
			},
		])
		expect(decision.refusal?.kind).toBe('port-open')
	})
})

describe('resolveIngressEngine', () => {
	it('defaults to core, follows config.egress.engine, and is overridden by its own', () => {
		expect(resolveIngressEngine(undefined, undefined)).toBe('core')
		expect(resolveIngressEngine(undefined, 'cilium')).toBe('cilium')
		expect(resolveIngressEngine({}, 'cilium')).toBe('cilium')
		expect(resolveIngressEngine({ engine: 'core' }, 'cilium')).toBe('core')
		expect(resolveIngressEngine({ engine: 'cilium' }, undefined)).toBe('cilium')
	})
})

describe('the refusal names what an operator has to act on', () => {
	it('lists the pod labels, the port and every policy examined', () => {
		const decision = decideCore([
			{ metadata: { name: 'other' }, spec: { podSelector: { matchLabels: { app: 'billing' } } } },
		])
		const error = new KubernetesIngressPolicyError(
			decision.refusal?.kind ?? 'no-covering-policy',
			'Sandbox namzu-ws-demo',
			POD_LABELS,
			AGENT_PORT,
			decision.examined,
			decision.refusal?.summary ?? '',
		)
		expect(error.name).toBe('KubernetesIngressPolicyError')
		expect(error.message).toContain(`${SANDBOX_TEMPLATE_LABEL_KEY}=${TASK_TEMPLATE}`)
		expect(error.message).toContain('TCP 1024')
		expect(error.message).toContain('NetworkPolicy/other [does-not-select]')
		expect(error.message).toContain("ingress: 'unverified'")
		expect(error.message).toContain('networkpolicy.yaml')
	})

	it('says the namespace holds no policy only when a list actually came back empty', () => {
		const empty = new KubernetesIngressPolicyError(
			'no-covering-policy',
			'Sandbox namzu-ws-demo',
			POD_LABELS,
			AGENT_PORT,
			[],
			'no applied policy enforces ingress on this pod.',
		)
		expect(empty.message).toContain('the namespace holds no policy')
		expect(empty.unread).toEqual([])
	})

	it('claims nothing about the namespace when the list itself failed, and says what to do instead', () => {
		// The defect this asserts against: an empty `examined` rendered as
		// "the namespace holds no policy of the kinds read" — a statement
		// about the cluster derived from a read the cluster refused.
		const refused = new KubernetesIngressPolicyError(
			'not-evaluable',
			'Sandbox namzu-ws-demo',
			POD_LABELS,
			AGENT_PORT,
			[],
			"the ServiceAccount this backend runs as may not 'list' networkpolicies (403: forbidden), so what the cluster admits on the agent port cannot be read.",
			[
				{
					resource: 'networkpolicies',
					path: `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies`,
					why: 'forbidden',
					reason: '403: forbidden',
				},
			],
		)
		expect(refused.message).not.toContain('the namespace holds no policy')
		expect(refused.message).toContain('none could be read')
		expect(refused.message).toContain('Not read: networkpolicies at')
		// And the action named is the one that fits: grant the verb, not
		// apply a policy this check never got to look for.
		expect(refused.message).toContain("grant this ServiceAccount 'list' on networkpolicies")
		expect(refused.message).not.toContain('apply k8s/manifests/networkpolicy.yaml')
		expect(refused.message).toContain("ingress: 'unverified'")
		// Nothing was examined here, so this is the one shape that DOES
		// support the sentence — the test below is its mirror.
		expect(refused.message).toContain('read no policy at all')
	})

	it('still reports the policies it DID read when a second collection could not be read', () => {
		const partial = new KubernetesIngressPolicyError(
			'not-evaluable',
			'Sandbox namzu-ws-demo',
			POD_LABELS,
			AGENT_PORT,
			[{ kind: 'NetworkPolicy', name: 'namzu-sandbox-baseline', verdict: 'covers' }],
			'the cluster serves no ciliumnetworkpolicies resource.',
			[
				{
					resource: 'ciliumnetworkpolicies',
					path: `/apis/cilium.io/v2/namespaces/${NAMESPACE}/ciliumnetworkpolicies`,
					why: 'absent',
					reason: 'the API server served no such collection',
				},
			],
		)
		expect(partial.message).toContain('NetworkPolicy/namzu-sandbox-baseline [covers]')
		expect(partial.message).toContain('Not read: ciliumnetworkpolicies at')
		expect(partial.message).toContain('point ingress.engine at a policy kind this cluster')
		// The remedy sentence is a claim too: it named a policy, with a
		// verdict, three sentences before this.
		expect(partial.message).not.toContain('read no policy at all')
		expect(partial.message).toContain('The policies named above were read')
	})
})

// ---------------------------------------------------------------------------
// End to end: that a create actually runs the check, and when.
// ---------------------------------------------------------------------------

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

beforeEach(async () => {
	// Every create reaches the guest before it resolves (the acquire-time
	// privilege probe), so these cases need a data plane as well as a
	// control plane — but what they are about is what happens BEFORE it.
	agent = await startScriptedAgent({ token: POD_UID })
	restoreDns = stubLoopbackDns()
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

interface ClusterOptions {
	/** Policies the `networkpolicies` LIST answers with. Empty = nobody applied one. */
	policies?: unknown[]
	/**
	 * Labels the bound pod reports, for the claim path — read per request so
	 * a case can change what the pool binds between two creates, which is how
	 * the per-label-set memo is proved to be one.
	 */
	podLabels?: () => Record<string, string>
	/** Status for the policy list, when a case is about a refused or missing read. */
	policyListStatus?: number
}

function workspaceTemplateBody(name: string) {
	return {
		metadata: { name, namespace: NAMESPACE },
		spec: {
			service: true,
			volumeClaimTemplates: [
				{
					metadata: { name: 'workspace' },
					spec: {
						accessModes: ['ReadWriteOnce'],
						volumeMode: 'Block',
						resources: { requests: { storage: '20Gi' } },
					},
				},
			],
			podTemplate: {
				spec: {
					containers: [
						{
							name: 'main',
							image: 'namzu/agent:test',
							volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
						},
					],
				},
			},
		},
	}
}

function taskTemplateBody() {
	return {
		metadata: { name: TASK_TEMPLATE, namespace: NAMESPACE },
		spec: { podTemplate: { spec: { containers: [{ name: 'main', image: 'namzu/agent:test' }] } } },
	}
}

function startCluster(options: ClusterOptions = {}): Promise<FakeApiServer> {
	const podLabels = options.podLabels ?? (() => ({ [SANDBOX_TEMPLATE_LABEL_KEY]: TASK_TEMPLATE }))
	// A workspace's `destroy()` suspends and then WAITS for the pod to stop,
	// so the pod has to go away when the operatingMode patch lands or every
	// teardown in this file times out on a fixture that never drains.
	let suspended = false
	return startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
			if (options.policyListStatus !== undefined) {
				return { status: options.policyListStatus, body: { message: 'refused' } }
			}
			return { status: 200, body: { items: options.policies ?? [] } }
		}
		if (req.method === 'GET' && req.path.endsWith('/ciliumnetworkpolicies')) {
			return { status: 200, body: { items: [] } }
		}
		if (req.method === 'GET' && req.path.includes(`/sandboxtemplates/${WORKSPACE_TEMPLATE}`)) {
			return { status: 200, body: workspaceTemplateBody(WORKSPACE_TEMPLATE) }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: taskTemplateBody() }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
			return { status: 201, body: {} }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
			return {
				status: 200,
				body: {
					status: {
						conditions: [readyCondition()],
						sandbox: {
							name: POOL_SANDBOX_NAME,
							serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
						},
					},
				},
			}
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			// A new Sandbox gets a new pod, which is what lets a second create
			// in one case follow a destroy in the first.
			suspended = false
			return { status: 201, body: {} }
		}
		if (req.method === 'PATCH') {
			const body = req.body as { spec?: { operatingMode?: string } }
			suspended = body?.spec?.operatingMode === 'Suspended'
			return { status: 200, body: {} }
		}
		if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
			return {
				status: 200,
				body: {
					metadata: { name },
					spec: { operatingMode: 'Running' },
					status: {
						conditions: [readyCondition()],
						podIPs: ['10.244.0.11'],
						serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local`,
						selector: 'agents.x-k8s.io/sandbox-name-hash=abc',
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			if (suspended) return { status: 404, body: { message: 'gone' } }
			return {
				status: 200,
				body: { metadata: { name: POOL_SANDBOX_NAME, uid: POD_UID, labels: podLabels() } },
			}
		}
		return { status: 404, body: { message: 'unexpected' } }
	})
}

function backendConfig(overrides: Record<string, unknown> = {}) {
	if (!server || !agent) throw new Error('fixtures not started')
	return {
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TASK_TEMPLATE,
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		...overrides,
	}
}

/** The baseline, with the port the scripted agent actually listens on. */
function appliedBaseline(): unknown[] {
	if (!agent) throw new Error('fixtures not started')
	return [baselineCorePolicy(agent.port)]
}

describe('a pool-less create()', () => {
	it('refuses before the POST when no applied policy covers the pod, leaving no Sandbox behind', async () => {
		server = await startCluster({ policies: [] })
		await expect(
			buildKubernetesBackend(backendConfig()).create({ workingDirectory: '/workspace' }),
		).rejects.toThrow(KubernetesIngressPolicyError)

		// The whole point of checking before the POST: nothing was created,
		// so there is no Sandbox to clean up and no PVC provisioned behind it.
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(1)
	})

	it('succeeds when the baseline policy is applied', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const sandbox = await buildKubernetesBackend(backendConfig()).create({
			workingDirectory: '/workspace',
		})
		expect(server.matching('POST', '/sandboxes')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses when a second applied policy opens the port, naming that policy', async () => {
		server = await startCluster({
			policies: [
				...appliedBaseline(),
				{
					metadata: { name: 'debug-access' },
					spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [{ from: [] }] },
				},
			],
		})
		await expect(
			buildKubernetesBackend(backendConfig()).create({ workingDirectory: '/workspace' }),
		).rejects.toThrow(/debug-access/)
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
	})
})

describe('a pooled create()', () => {
	it('checks the BOUND pod’s own labels, and succeeds when a policy covers them', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const sandbox = await buildKubernetesBackend(
			backendConfig({ warmPoolName: 'namzu-task-pool' }),
		).create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('releases the claim when the bound pod turns out not to be covered', async () => {
		server = await startCluster({
			policies: appliedBaseline(),
			// A pool whose template forgot the label this backend's policies
			// select by: the claim binds, and the pod it bound is uncovered.
			podLabels: () => ({ 'agents.x-k8s.io/sandbox-name-hash': 'abc' }),
		})
		await expect(
			buildKubernetesBackend({ ...backendConfig(), warmPoolName: 'namzu-task-pool' }).create({
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(KubernetesIngressPolicyError)
		// The claim was POSTed before the pod existed, so the refusal has to
		// give it back — the same cleanup a failed privilege probe uses.
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(1)
	})

	it('caches the pass per label set, not globally', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const backend = buildKubernetesBackend(backendConfig({ warmPoolName: 'namzu-task-pool' }))
		const first = await backend.create({ workingDirectory: '/workspace' })
		const second = await backend.create({ workingDirectory: '/workspace' })
		// Both creates bound a pod with identical labels, so one read served
		// both — the memo is real.
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(1)
		await first.destroy()
		await second.destroy()
	})

	it('re-reads for a DIFFERENT label set rather than reusing another pod’s answer', async () => {
		let labels: Record<string, string> = { [SANDBOX_TEMPLATE_LABEL_KEY]: TASK_TEMPLATE }
		// The baseline selects the template label by EXISTENCE, so both label
		// sets pass — what is being measured is how many times it was read.
		server = await startCluster({ policies: appliedBaseline(), podLabels: () => labels })
		const backend = buildKubernetesBackend(backendConfig({ warmPoolName: 'namzu-task-pool' }))
		const first = await backend.create({ workingDirectory: '/workspace' })
		labels = { [SANDBOX_TEMPLATE_LABEL_KEY]: WORKSPACE_TEMPLATE }
		const second = await backend.create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(2)
		await first.destroy()
		await second.destroy()
	})
})

describe('createKubernetesWorkspace', () => {
	function workspaceConfig(overrides: Record<string, unknown> = {}) {
		return backendConfig({ sandboxTemplateName: WORKSPACE_TEMPLATE, ...overrides })
	}

	it('refuses before the POST when no applied policy covers the workspace pod', async () => {
		server = await startCluster({ policies: [] })
		await expect(
			createKubernetesWorkspace(workspaceConfig(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(KubernetesIngressPolicyError)
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
	})

	it('names the workspace, its labels and the policies it examined', async () => {
		server = await startCluster({
			policies: [
				{
					metadata: { name: 'billing' },
					spec: { podSelector: { matchLabels: { app: 'billing' } } },
				},
			],
		})
		await expect(
			createKubernetesWorkspace(workspaceConfig(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(
			new RegExp(
				`${WORKSPACE_ID}[\\s\\S]*${SANDBOX_TEMPLATE_LABEL_KEY}=${WORKSPACE_TEMPLATE}[\\s\\S]*NetworkPolicy/billing`,
			),
		)
	})

	it('succeeds when the baseline policy is applied', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const workspace = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		expect(workspace.origin).toBe('created')
		expect(server.matching('POST', '/sandboxes')).toHaveLength(1)
		await workspace.destroy()
	})

	it('refuses an EXISTING workspace without resuming it once the policy is deleted', async () => {
		// The Sandbox already stands there and is asleep: a create would
		// normally adopt it and PATCH it back to Running.
		server = await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: [] } }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: workspaceTemplateBody(WORKSPACE_TEMPLATE) }
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
				return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
			}
			return { status: 404, body: { message: 'unexpected' } }
		})

		await expect(
			createKubernetesWorkspace(workspaceConfig(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(KubernetesIngressPolicyError)
		// Not adopted, not resumed, not even asked about: the refusal lands
		// before the POST that would have found the 409.
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
	})

	it('re-reads the policies on EVERY call rather than memoizing, unlike the provider path', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const first = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await first.destroy()
		const second = await createKubernetesWorkspace(workspaceConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(2)
		await second.destroy()
	})
})

describe("ingress: 'unverified'", () => {
	it('reads no policy at all and issues no additional request', async () => {
		server = await startCluster({ policies: [] })
		const sandbox = await buildKubernetesBackend(
			backendConfig({ ingress: 'unverified' as const }),
		).create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(0)
		expect(server.matching('GET', '/ciliumnetworkpolicies')).toHaveLength(0)
		await sandbox.destroy()
	})

	it('opts a workspace out too', async () => {
		server = await startCluster({ policies: [] })
		const workspace = await createKubernetesWorkspace(
			backendConfig({ sandboxTemplateName: WORKSPACE_TEMPLATE, ingress: 'unverified' as const }),
			{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
		)
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(0)
		await workspace.destroy()
	})
})

describe("engine: 'cilium'", () => {
	it('lists BOTH policy kinds, because an open rule in either one opens the port', async () => {
		server = await startCluster({ policies: appliedBaseline() })
		const sandbox = await buildKubernetesBackend(
			backendConfig({ ingress: { engine: 'cilium' as const } }),
		).create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies')).toHaveLength(1)
		expect(server.matching('GET', '/ciliumnetworkpolicies')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses, naming the engine, when the cluster serves no such CRD', async () => {
		server = await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: appliedBaseline() } }
			}
			if (req.method === 'GET' && req.path.endsWith('/ciliumnetworkpolicies')) {
				return {
					status: 404,
					body: { message: 'the server could not find the requested resource' },
				}
			}
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: taskTemplateBody() }
			}
			return { status: 404, body: { message: 'unexpected' } }
		})
		await expect(
			buildKubernetesBackend(backendConfig({ ingress: { engine: 'cilium' as const } })).create({
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(/serves no ciliumnetworkpolicies resource/)
	})

	it('keeps the core policies it already read in the refusal, and names only the CRD as unread', async () => {
		server = await startFakeApiServer((req: RecordedRequest): FakeApiReply => {
			if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
				return { status: 200, body: { items: appliedBaseline() } }
			}
			if (req.method === 'GET' && req.path.endsWith('/ciliumnetworkpolicies')) {
				return {
					status: 404,
					body: { message: 'the server could not find the requested resource' },
				}
			}
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: taskTemplateBody() }
			}
			return { status: 404, body: { message: 'unexpected' } }
		})
		const failure = await buildKubernetesBackend(
			backendConfig({ ingress: { engine: 'cilium' as const } }),
		)
			.create({ workingDirectory: '/workspace' })
			.then(
				() => undefined,
				(err: unknown) => err,
			)
		const error = failure as KubernetesIngressPolicyError
		// The core list WAS enumerated, and a refusal that dropped it would
		// report less than the check knows.
		expect(error.examined).toEqual([
			{ kind: 'NetworkPolicy', name: 'namzu-sandbox-baseline', verdict: 'covers' },
		])
		expect(error.unread.map((source) => source.resource)).toEqual(['ciliumnetworkpolicies'])
		expect(error.message).toContain('NetworkPolicy/namzu-sandbox-baseline [covers]')
		expect(error.message).not.toContain('read no policy at all')
	})
})

describe('a read it is not allowed to make', () => {
	it('refuses naming the missing verb rather than letting a 403 travel as itself', async () => {
		server = await startCluster({ policyListStatus: 403 })
		await expect(
			buildKubernetesBackend(backendConfig()).create({ workingDirectory: '/workspace' }),
		).rejects.toThrow(/may not 'list' networkpolicies/)
	})

	it('describes no namespace it never enumerated, all the way out to the caller', async () => {
		server = await startCluster({ policyListStatus: 403 })
		const failure = await buildKubernetesBackend(backendConfig())
			.create({ workingDirectory: '/workspace' })
			.then(
				() => undefined,
				(err: unknown) => err,
			)
		expect(failure).toBeInstanceOf(KubernetesIngressPolicyError)
		const error = failure as KubernetesIngressPolicyError
		expect(error.message).not.toContain('the namespace holds no policy')
		expect(error.examined).toEqual([])
		expect(error.unread).toEqual([
			{
				resource: 'networkpolicies',
				path: `/apis/networking.k8s.io/v1/namespaces/${NAMESPACE}/networkpolicies`,
				why: 'forbidden',
				reason: expect.stringContaining('403'),
			},
		])
	})
})
