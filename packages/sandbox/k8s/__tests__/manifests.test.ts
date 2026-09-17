/**
 * Structural checks on every manifest under `../manifests/` — parsed with
 * `yaml` (a devDependency added for exactly this; `@namzu/sandbox` still
 * carries no RUNTIME dependency, and this package has no YAML parser
 * anywhere in `src/` — see `k8s-client.ts`'s own module comment for why
 * that stays true even here).
 *
 * These are ASSERTIONS ABOUT THE MANIFESTS, not a Kubernetes admission
 * check — `../README.md` covers `kubectl apply --dry-run=server` against a
 * real API server for that. What this file catches is the class of mistake
 * a dry-run against a CRD's OWN schema cannot: a Role with a wildcard verb
 * that is still perfectly valid RBAC, a `NetworkPolicy` that parses fine
 * but forgot to restrict ingress, a template missing `runtimeClassName`
 * that a schema has no opinion about at all.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
const MANIFESTS_DIR = join(HERE, '../manifests')

function loadYaml(fileName: string): unknown[] {
	const text = readFileSync(join(MANIFESTS_DIR, fileName), 'utf8')
	return parseAllDocuments(text).map((doc) => doc.toJS())
}

function loadOne(fileName: string): Record<string, unknown> {
	const docs = loadYaml(fileName)
	expect(docs).toHaveLength(1)
	return docs[0] as Record<string, unknown>
}

/** Every string value in a JSON-like tree, depth-first — for the no-inline-secret scan. */
function collectStrings(value: unknown, out: string[] = []): string[] {
	if (typeof value === 'string') {
		out.push(value)
	} else if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, out)
	} else if (value !== null && typeof value === 'object') {
		for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
	}
	return out
}

// Recognisable credential SHAPES, not a word denylist — a comment saying
// "no secret here" would trip a substring check and prove nothing. A JWT
// (two dots, base64url segments) and a PEM block are both things that
// cannot appear by accident in a Kubernetes manifest's own vocabulary.
const JWT_SHAPE = /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/
const PEM_MARKER = /-----BEGIN [A-Z ]*(PRIVATE|SECRET)/

function assertNoInlineSecrets(fileName: string, docs: unknown[]): void {
	for (const doc of docs) {
		const record = doc as Record<string, unknown>
		expect(record.kind, `${fileName} defines a Secret object`).not.toBe('Secret')
		for (const value of collectStrings(doc)) {
			expect(JWT_SHAPE.test(value), `${fileName} contains a JWT-shaped string: ${value}`).toBe(
				false,
			)
			expect(PEM_MARKER.test(value), `${fileName} contains a PEM key block`).toBe(false)
		}
	}
}

/** Every `{name, valueFrom|value}` entry across every container's `env`, both lists. */
function collectEnvEntries(podSpec: Record<string, unknown>): Record<string, unknown>[] {
	const entries: Record<string, unknown>[] = []
	for (const key of ['containers', 'initContainers']) {
		const list = (podSpec[key] as Record<string, unknown>[] | undefined) ?? []
		for (const container of list) {
			for (const env of (container.env as Record<string, unknown>[] | undefined) ?? []) {
				entries.push(env)
			}
		}
	}
	return entries
}

function assertBindTokenFromDownwardApi(fileName: string, podSpec: Record<string, unknown>): void {
	const entry = collectEnvEntries(podSpec).find((e) => e.name === 'NAMZU_AGENT_BIND_TOKEN')
	expect(entry, `${fileName} never sets NAMZU_AGENT_BIND_TOKEN`).toBeDefined()
	expect(entry?.value, `${fileName}'s NAMZU_AGENT_BIND_TOKEN is a literal value, not fieldRef`).toBeUndefined()
	const valueFrom = entry?.valueFrom as Record<string, unknown> | undefined
	const fieldRef = valueFrom?.fieldRef as Record<string, unknown> | undefined
	expect(fieldRef?.fieldPath).toBe('metadata.uid')
}

describe('every manifest parses as YAML', () => {
	it.each([
		'runtimeclass.yaml',
		'sandboxtemplate-task.yaml',
		'sandboxtemplate-workspace.yaml',
		'sandboxwarmpool.yaml',
		'networkpolicy.yaml',
		'rbac.yaml',
	])('%s', (fileName) => {
		expect(() => loadYaml(fileName)).not.toThrow()
	})
})

describe('no manifest contains an inline secret value', () => {
	it.each([
		'runtimeclass.yaml',
		'sandboxtemplate-task.yaml',
		'sandboxtemplate-workspace.yaml',
		'sandboxwarmpool.yaml',
		'networkpolicy.yaml',
		'rbac.yaml',
	])('%s', (fileName) => {
		assertNoInlineSecrets(fileName, loadYaml(fileName))
	})
})

describe('sandboxtemplate-task.yaml', () => {
	const template = loadOne('sandboxtemplate-task.yaml')
	const podSpec = (template.spec as Record<string, unknown>).podTemplate as Record<string, unknown>
	const spec = podSpec.spec as Record<string, unknown>

	it('names a runtimeClassName', () => {
		expect(typeof spec.runtimeClassName).toBe('string')
		expect(spec.runtimeClassName).not.toBe('')
	})

	it('carries the backend-owned template label, equal to its own name', () => {
		const labels = (podSpec.metadata as Record<string, unknown>).labels as Record<string, string>
		expect(labels['sandbox.namzu.ai/template']).toBe((template.metadata as Record<string, unknown>).name)
	})

	it('reads NAMZU_AGENT_BIND_TOKEN from the downward API, never a literal', () => {
		assertBindTokenFromDownwardApi('sandboxtemplate-task.yaml', spec)
	})

	it('declares no volumeClaimTemplates (a task sandbox carries no disk)', () => {
		expect((template.spec as Record<string, unknown>).volumeClaimTemplates).toBeUndefined()
	})

	it('runs non-root, with no capabilities and no privilege escalation (#491)', () => {
		const containers = spec.containers as Record<string, unknown>[]
		expect(containers).toHaveLength(1)
		const securityContext = containers[0]?.securityContext as Record<string, unknown>
		expect(securityContext, 'container carries no securityContext').toBeDefined()

		// The flag this whole fix exists to remove — a pod that mounts no
		// device (asserted above) has no runtime reason to carry it, and it
		// also rules out any seccompProfile.
		expect(securityContext.privileged).not.toBe(true)

		expect(securityContext.runAsNonRoot).toBe(true)
		expect(securityContext.allowPrivilegeEscalation).toBe(false)

		const capabilities = securityContext.capabilities as Record<string, unknown> | undefined
		expect(capabilities?.drop, 'capabilities.drop').toEqual(['ALL'])

		const seccompProfile = securityContext.seccompProfile as Record<string, unknown> | undefined
		expect(seccompProfile?.type).toBe('RuntimeDefault')
	})

	it('runAsUser/runAsGroup match the Dockerfile\'s AGENT_UID/AGENT_GID (1001)', () => {
		const containers = spec.containers as Record<string, unknown>[]
		const securityContext = containers[0]?.securityContext as Record<string, unknown>
		expect(securityContext.runAsUser).toBe(1001)
		expect(securityContext.runAsGroup).toBe(1001)
	})
})

describe('sandboxtemplate-workspace.yaml', () => {
	const template = loadOne('sandboxtemplate-workspace.yaml')
	const templateSpec = template.spec as Record<string, unknown>
	const podSpec = (templateSpec.podTemplate as Record<string, unknown>).spec as Record<string, unknown>

	it('names a runtimeClassName', () => {
		expect(typeof podSpec.runtimeClassName).toBe('string')
		expect(podSpec.runtimeClassName).not.toBe('')
	})

	it('reads NAMZU_AGENT_BIND_TOKEN from the downward API, never a literal', () => {
		assertBindTokenFromDownwardApi('sandboxtemplate-workspace.yaml', podSpec)
	})

	it('stays privileged (#491: only the task template was narrowed — this pod formats/mounts a raw device)', () => {
		const containers = podSpec.containers as Record<string, unknown>[]
		const securityContext = containers[0]?.securityContext as Record<string, unknown>
		expect(securityContext.privileged).toBe(true)
	})

	it('the volumeClaimTemplate is volumeMode: Block, with a matching volumeDevices entry', () => {
		const vcts = templateSpec.volumeClaimTemplates as Record<string, unknown>[]
		expect(vcts).toHaveLength(1)
		const vct = vcts[0] as Record<string, unknown>
		expect((vct.spec as Record<string, unknown>).volumeMode).toBe('Block')

		const vctName = (vct.metadata as Record<string, unknown>).name
		const containers = podSpec.containers as Record<string, unknown>[]
		const devices = containers.flatMap(
			(c) => (c.volumeDevices as Record<string, unknown>[] | undefined) ?? [],
		)
		expect(devices.some((d) => d.name === vctName)).toBe(true)
		// Block mode is mounted via volumeDevices, never volumeMounts — a
		// volumeMounts entry naming the same PVC would be the Filesystem-mode
		// mistake docs/sdk/kubernetes-sandbox.md's workspace section warns
		// against (several times slower at small-file IO under a VM
		// boundary — exactly what ../scripts/io-compare.mjs measures).
		const mounts = containers.flatMap(
			(c) => (c.volumeMounts as Record<string, unknown>[] | undefined) ?? [],
		)
		expect(mounts.some((m) => m.name === vctName)).toBe(false)
	})

	it('the device env var points at the same path the volumeDevices entry mounts it at', () => {
		const containers = podSpec.containers as Record<string, unknown>[]
		const device = collectEnvEntries(podSpec).find((e) => e.name === 'NAMZU_WORKSPACE_DEVICE')
		expect(device?.value).toBeDefined()
		const devicePaths = containers.flatMap(
			(c) => (c.volumeDevices as Record<string, unknown>[] | undefined) ?? [],
		).map((d) => d.devicePath)
		expect(devicePaths).toContain(device?.value)
	})
})

describe('networkpolicy.yaml', () => {
	const policy = loadOne('networkpolicy.yaml')
	const spec = policy.spec as Record<string, unknown>

	it('is Ingress AND Egress scoped, never bare (an unlisted type enforces nothing)', () => {
		expect(spec.policyTypes).toEqual(expect.arrayContaining(['Ingress', 'Egress']))
	})

	it('ingress is restricted to exactly the host selector, on the agent port and nothing else', () => {
		const ingress = spec.ingress as Record<string, unknown>[]
		expect(ingress).toHaveLength(1)
		const rule = ingress[0] as Record<string, unknown>
		const from = rule.from as Record<string, unknown>[]
		expect(from).toHaveLength(1)
		const podSelector = from[0]?.podSelector as Record<string, unknown>
		expect(podSelector.matchLabels).toBeDefined()
		const ports = rule.ports as Record<string, unknown>[]
		expect(ports).toEqual([{ protocol: 'TCP', port: 1024 }])
	})

	it('selects sandboxes by the backend-owned template label existing, not one literal value', () => {
		const podSelector = spec.podSelector as Record<string, unknown>
		const expressions = podSelector.matchExpressions as Record<string, unknown>[]
		expect(expressions.some((e) => e.key === 'sandbox.namzu.ai/template' && e.operator === 'Exists')).toBe(
			true,
		)
	})
})

describe('rbac.yaml', () => {
	const docs = loadYaml('rbac.yaml') as Record<string, unknown>[]
	const role = docs.find((d) => d.kind === 'Role') as Record<string, unknown>
	const roleBinding = docs.find((d) => d.kind === 'RoleBinding') as Record<string, unknown>

	it('is a namespaced Role, never a ClusterRole', () => {
		expect(role.kind).toBe('Role')
		expect((role.metadata as Record<string, unknown>).namespace).toBeTruthy()
	})

	it('grants no wildcard apiGroup, resource or verb', () => {
		const rules = role.rules as Record<string, unknown>[]
		expect(rules.length).toBeGreaterThan(0)
		for (const rule of rules) {
			for (const field of ['apiGroups', 'resources', 'verbs'] as const) {
				const values = rule[field] as string[]
				expect(values, `${field} on a rule`).toBeDefined()
				expect(values).not.toContain('*')
			}
		}
	})

	it('grants exactly the verbs the backend issues, no more', () => {
		const rules = role.rules as Record<string, unknown>[]
		const byResource = new Map<string, Set<string>>()
		for (const rule of rules) {
			for (const resource of rule.resources as string[]) {
				const verbs = byResource.get(resource) ?? new Set<string>()
				for (const verb of rule.verbs as string[]) verbs.add(verb)
				byResource.set(resource, verbs)
			}
		}
		expect(byResource.get('sandboxclaims')).toEqual(new Set(['create', 'get', 'patch', 'delete']))
		// `list` is listKubernetesWorkspaces's, and only its: a workspace
		// inventory has to read the collection, while every other read in the
		// backend is a GET by a name it already knows.
		expect(byResource.get('sandboxes')).toEqual(
			new Set(['create', 'get', 'list', 'patch', 'delete']),
		)
		expect(byResource.get('sandboxtemplates')).toEqual(new Set(['get']))
		expect(byResource.get('sandboxwarmpools')).toEqual(new Set(['get']))
		expect(byResource.get('pods')).toEqual(new Set(['get', 'list']))
		// `get` is the egress NAMED-object check's (one object, by name);
		// `list` is what both enumerating checks need — ingress coverage of the
		// agent port, and the egress union — because a name proves existence
		// and not selection.
		expect(byResource.get('networkpolicies')).toEqual(new Set(['get', 'list']))
		expect(byResource.get('ciliumnetworkpolicies')).toEqual(new Set(['get', 'list']))
	})

	it('grants list on both policy resources, which the egress union check enumerates too', () => {
		// Asserted separately from the verb-set case above because these two
		// verbs are now load-bearing for a SECOND default-on refusal: without
		// `list`, a deployment that sets `config.egress` fails every create
		// with a not-evaluable refusal naming the missing grant.
		const rules = role.rules as Record<string, unknown>[]
		for (const resource of ['networkpolicies', 'ciliumnetworkpolicies']) {
			const rule = rules.find((r) => (r.resources as string[]).includes(resource))
			expect(rule, `no rule grants ${resource}`).toBeDefined()
			expect(rule?.verbs, `${resource} is not listable`).toContain('list')
		}
	})

	it('grants get AND list on ciliumnetworkpolicies in the cilium.io apiGroup, for engine: "cilium"', () => {
		const rules = role.rules as Record<string, unknown>[]
		const rule = rules.find((r) => (r.resources as string[]).includes('ciliumnetworkpolicies'))
		expect(rule, 'no rule grants ciliumnetworkpolicies').toBeDefined()
		expect(rule?.apiGroups).toEqual(['cilium.io'])
		expect(rule?.verbs).toEqual(['get', 'list'])
	})

	it('binds the Role to the ServiceAccount this backend actually runs as', () => {
		const subjects = roleBinding.subjects as Record<string, unknown>[]
		expect(subjects).toHaveLength(1)
		expect(subjects[0]?.kind).toBe('ServiceAccount')
		const roleRef = roleBinding.roleRef as Record<string, unknown>
		expect(roleRef.name).toBe((role.metadata as Record<string, unknown>).name)
	})
})

describe('runtimeclass.yaml', () => {
	it('is a RuntimeClass with a non-empty name and handler', () => {
		const runtimeClass = loadOne('runtimeclass.yaml')
		expect((runtimeClass.metadata as Record<string, unknown>).name).toBeTruthy()
		expect(runtimeClass.handler).toBeTruthy()
	})
})

describe('sandboxwarmpool.yaml', () => {
	it('references namzu-task, the template this backend claims against', () => {
		const pool = loadOne('sandboxwarmpool.yaml')
		const ref = (pool.spec as Record<string, unknown>).sandboxTemplateRef as Record<string, unknown>
		expect(ref.name).toBe('namzu-task')
	})
})
