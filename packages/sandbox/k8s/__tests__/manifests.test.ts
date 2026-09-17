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

import { readFileSync, readdirSync } from 'node:fs'
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

/**
 * Every YAML manifest under `manifests/`, at any depth, named relative to
 * it. BOTH extensions, because `kubectl` and Kustomize accept `.yml` as
 * readily as `.yaml` and this scan is only as wide as what it walks: a
 * single-extension scan would put a future `patch-….yml` overlay outside
 * every case that reads this list, silently, which is the failure mode the
 * preStop scan below exists to catch.
 */
function manifestFiles(dir: string = MANIFESTS_DIR, prefix = ''): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
		if (entry.isDirectory()) out.push(...manifestFiles(join(dir, entry.name), relative))
		else if (/\.ya?ml$/.test(entry.name)) out.push(relative)
	}
	return out
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

	it('runs the entrypoint\'s prestop verb as a preStop hook (#484)', () => {
		const containers = podSpec.containers as Record<string, unknown>[]
		const lifecycle = containers[0]?.lifecycle as Record<string, unknown> | undefined
		const exec = (lifecycle?.preStop as Record<string, unknown> | undefined)?.exec as
			| Record<string, unknown>
			| undefined
		// The hook is the one flush that happens BEFORE the stop signal, so
		// it is the only one that does not depend on the signal being
		// delivered and handled in time — measured in #484 as the thing that
		// did not happen on a VM runtime class.
		expect(exec?.command).toEqual(['/entrypoint.sh', 'prestop'])
	})

	it('gives the flush a grace period, and keeps it under the host\'s ready timeout (#484)', () => {
		const grace = podSpec.terminationGracePeriodSeconds
		expect(typeof grace).toBe('number')
		// It has to cover the preStop hook's flush AND the agent's own
		// bounded drain-and-flush after the signal, so it cannot be the 5s
		// it was; and it has to stay well under the host's readyTimeoutMs
		// (60s by default), which bounds how long suspend() waits for the
		// pod to be gone — a grace period at or above that turns every
		// suspend into a timeout error.
		expect(grace as number).toBeGreaterThanOrEqual(20)
		expect(grace as number).toBeLessThanOrEqual(45)
		const shutdown = collectEnvEntries(podSpec).find(
			(e) => e.name === 'NAMZU_AGENT_SHUTDOWN_DEADLINE_MS',
		)
		// And the agent's own bound has to fit inside it, with room for the
		// hook: a handler still running when the kubelet's SIGKILL lands has
		// not flushed anything.
		expect(Number(shutdown?.value)).toBeLessThan((grace as number) * 1000)
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

describe('every workspace template that states `containers` in full carries the preStop hook (#484)', () => {
	/**
	 * A `containers` array in a patch REPLACES the base template's entire
	 * array under a JSON merge patch, so a manifest that names the container
	 * has to repeat every field of it the pod still needs — there is no
	 * inheritance inside an array. `kind-overlay/
	 * patch-workspace-filesystem-pvc.yaml` dropped `lifecycle` exactly that
	 * way, which is the failure this case exists to make impossible to
	 * repeat: a workspace pod on kind still had the agent's own SIGTERM
	 * handler and no hook at all, so the one flush that happens BEFORE the
	 * kubelet's stop signal was missing from everything tested on kind.
	 *
	 * The scan is over every `SandboxTemplate` named `namzu-workspace`
	 * anywhere under `manifests/` that gives its containers, rather than a
	 * list of files, so a new overlay is covered the moment it exists.
	 * `sandboxtemplate-task.yaml` and its overlay state their containers in
	 * full too and deliberately carry NO hook: a task sandbox has no disk to
	 * flush (no `volumeClaimTemplates`, no `NAMZU_WORKSPACE_DEVICE`), its
	 * `terminationGracePeriodSeconds` is 5, and the wait the hook would
	 * derive from the shutdown deadline that template now SETS is
	 * `ceil(3000 / 1000) + 2` = 5 — the whole of that grace period, so the
	 * kubelet would have no room left after it. The task template is
	 * therefore out of scope by NAME here, and the count below is what keeps
	 * that from silently becoming "no templates at all". What pins ITS pair
	 * of numbers is the separate scan below, which is about the deadline and
	 * the grace period rather than about the hook.
	 */
	function workspaceTemplatesWithContainers(): {
		file: string
		containers: Record<string, unknown>[]
	}[] {
		const found: { file: string; containers: Record<string, unknown>[] }[] = []
		for (const file of manifestFiles()) {
			for (const doc of loadYaml(file)) {
				const record = doc as Record<string, unknown>
				if (record.kind !== 'SandboxTemplate') continue
				const metadata = record.metadata as Record<string, unknown> | undefined
				if (metadata?.name !== 'namzu-workspace') continue
				const spec = record.spec as Record<string, unknown> | undefined
				const podTemplate = spec?.podTemplate as Record<string, unknown> | undefined
				const podSpec = podTemplate?.spec as Record<string, unknown> | undefined
				const containers = podSpec?.containers
				if (Array.isArray(containers)) {
					found.push({ file, containers: containers as Record<string, unknown>[] })
				}
			}
		}
		return found
	}

	it('finds the base template and every overlay that gives its containers, not nothing', () => {
		const files = workspaceTemplatesWithContainers().map((t) => t.file)
		expect(files).toEqual(
			expect.arrayContaining([
				'sandboxtemplate-workspace.yaml',
				'kind-overlay/patch-workspace-filesystem-pvc.yaml',
			]),
		)
	})

	it('carries `/entrypoint.sh prestop` as the preStop command on every one of them', () => {
		const templates = workspaceTemplatesWithContainers()
		expect(templates.length).toBeGreaterThan(0)
		for (const { file, containers } of templates) {
			const agent = containers.find((c) => c.name === 'agent')
			expect(agent, `${file} has no container named agent`).toBeDefined()
			const lifecycle = agent?.lifecycle as Record<string, unknown> | undefined
			const exec = (lifecycle?.preStop as Record<string, unknown> | undefined)?.exec as
				| Record<string, unknown>
				| undefined
			// The command, not just the presence of a hook: `sync -f` and the
			// guarded signal are both in the verb this names, and a hook that
			// ran anything else would be a different promise wearing the same
			// key. An overlay that replaced `containers` without repeating
			// this block is exactly what fails here.
			expect(exec?.command, `${file} drops the preStop hook`).toEqual([
				'/entrypoint.sh',
				'prestop',
			])
		}
	})
})

describe('every template that bounds the agent\'s drain fits that bound inside its own grace period (#484)', () => {
	/**
	 * THE PAIR. `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` bounds the WHOLE `SIGTERM`
	 * handler — close the listener, quiesce every process the guest is
	 * running, flush, `exit 0` — and it is that handler's only bound.
	 * `terminationGracePeriodSeconds` is when the kubelet SIGKILLs the
	 * container. So a deadline at or above the grace period is a bound that
	 * can never be reached on its own terms: the kill lands first and the
	 * drain it bounds is truncated instead of finished, which is the very
	 * outcome the bound exists to replace, arrived at by setting it too
	 * high. That is not hypothetical — `sandboxtemplate-task.yaml` shipped a
	 * 5s grace period and no deadline at all, so its pods ran on the agent's
	 * 15000ms default and were killed mid-drain.
	 *
	 * A `preStop` hook tightens the pair one more notch, and the reason is
	 * the kubelet's teardown order: it runs the hook, waits for the hook to
	 * return, and only THEN sends its own stop signal to pid 1. The hook's
	 * wait is derived from the deadline as `ceil(deadline / 1000) + 2`
	 * seconds, so a hook whose derived wait does not fit inside the grace
	 * period ends while the agent is still draining and hands it a signal
	 * the kubelet sent only because the hook gave up. Both rules are
	 * asserted against the SHIPPED manifests rather than against literals,
	 * because these numbers live in different files and that is how they
	 * drift apart.
	 *
	 * WHAT IS SKIPPED, AND WHY SKIPPING IS NOT VACUOUS. The scan is keyed on
	 * a container that sets the deadline to a literal value, so the two
	 * `kind-overlay/` patches — which state `containers` in full and
	 * deliberately omit it, because `env` is an array and a patch replaces
	 * one wholesale — are out of scope by construction. Their pods run on
	 * the agent's 15000ms default, and asserting that default against a grace
	 * period the patch INHERITS from the base is the base template's own case
	 * asserted a second time, not a fact about the overlay. Equally, a
	 * template that ships no hook has no derived wait to check; the rule it
	 * does have to satisfy is the deadline rule, and the case below says so
	 * rather than computing something it cannot fail on. The two counts are
	 * what keep "nothing in scope" from passing silently.
	 */
	function templatesThatBoundTheDrain(): {
		file: string
		graceSeconds: number
		deadlineMs: number
		hookWaitSeconds: number
		hasHook: boolean
	}[] {
		const found: {
			file: string
			graceSeconds: number
			deadlineMs: number
			hookWaitSeconds: number
			hasHook: boolean
		}[] = []
		for (const file of manifestFiles()) {
			for (const doc of loadYaml(file)) {
				const record = doc as Record<string, unknown>
				if (record.kind !== 'SandboxTemplate') continue
				const spec = record.spec as Record<string, unknown> | undefined
				const podTemplate = spec?.podTemplate as Record<string, unknown> | undefined
				const podSpec = podTemplate?.spec as Record<string, unknown> | undefined
				const graceSeconds = podSpec?.terminationGracePeriodSeconds
				if (typeof graceSeconds !== 'number') continue
				const containers = (podSpec?.containers as Record<string, unknown>[] | undefined) ?? []
				for (const container of containers) {
					const entry = ((container.env as Record<string, unknown>[] | undefined) ?? []).find(
						(e) => e.name === 'NAMZU_AGENT_SHUTDOWN_DEADLINE_MS',
					)
					if (entry === undefined) continue
					const lifecycle = container.lifecycle as Record<string, unknown> | undefined
					const exec = (lifecycle?.preStop as Record<string, unknown> | undefined)?.exec as
						| Record<string, unknown>
						| undefined
					found.push({
						file,
						graceSeconds,
						deadlineMs: Number(entry.value),
						// The derivation `entrypoint.sh prestop` performs, in the
						// whole seconds its wait is counted in. `entrypoint.test.ts`
						// drives that script directly to prove the formula is this
						// one; what is checked here is the manifests' own numbers.
						hookWaitSeconds: Math.ceil(Number(entry.value) / 1000) + 2,
						hasHook: exec?.command !== undefined,
					})
				}
			}
		}
		return found
	}

	it('finds the templates that ship the pair, not nothing', () => {
		const files = templatesThatBoundTheDrain().map((t) => t.file)
		expect(files).toEqual(
			expect.arrayContaining(['sandboxtemplate-task.yaml', 'sandboxtemplate-workspace.yaml']),
		)
	})

	it('keeps the agent\'s own bound inside the grace period on every one of them', () => {
		const templates = templatesThatBoundTheDrain()
		expect(templates.length).toBeGreaterThan(0)
		for (const { file, graceSeconds, deadlineMs } of templates) {
			expect(Number.isFinite(deadlineMs), `${file} sets no numeric agent shutdown deadline`).toBe(true)
			expect(deadlineMs, `${file} sets a non-positive agent shutdown deadline`).toBeGreaterThan(0)
			// Strictly inside, not merely not-after: the kubelet still has to
			// deliver the signal through the container's init and tear the
			// container down once the handler exits, and a deadline that
			// spends the whole countdown leaves none of that any room.
			expect(
				deadlineMs,
				`${file}'s agent bound outlives its ${graceSeconds}s grace period, so the drain can only be truncated`,
			).toBeLessThan(graceSeconds * 1000)
		}
	})

	it('keeps the preStop hook\'s derived wait inside the grace period wherever a hook is shipped', () => {
		const withHook = templatesThatBoundTheDrain().filter((t) => t.hasHook)
		// A template that ships NO hook is not judged by this rule and is not
		// made to pass it vacuously either: it has no wait of its own to
		// derive, and the rule it does have to satisfy is the deadline one
		// above. `sandboxtemplate-task.yaml` is that template — its derived
		// wait is `ceil(3000 / 1000) + 2` = 5, the whole of its 5s grace
		// period, and that is the reason its own comment gives for carrying no
		// hook rather than a defect this case could catch.
		expect(withHook.length).toBeGreaterThan(0)
		for (const { file, graceSeconds, hookWaitSeconds } of withHook) {
			expect(
				hookWaitSeconds,
				`${file}'s hook wait ends with its ${graceSeconds}s grace period instead of inside it`,
			).toBeLessThan(graceSeconds)
		}
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
		// `list` is releaseKubernetesTaskSandboxes's and readKubernetesTaskCapacity's:
		// crash recovery has to find a predecessor's claims by label, and a
		// capacity read counts every claim bound to the configured pool.
		expect(byResource.get('sandboxclaims')).toEqual(
			new Set(['create', 'get', 'list', 'patch', 'delete']),
		)
		// `list` is listKubernetesWorkspaces's, and only its: a workspace
		// inventory has to read the collection, while every other read in the
		// backend is a GET by a name it already knows.
		expect(byResource.get('sandboxes')).toEqual(
			new Set(['create', 'get', 'list', 'patch', 'delete']),
		)
		expect(byResource.get('sandboxtemplates')).toEqual(new Set(['get']))
		expect(byResource.get('sandboxwarmpools')).toEqual(new Set(['get']))
		expect(byResource.get('pods')).toEqual(new Set(['get', 'list']))
		// `get` and nothing more: a workspace handle reads each of its PVCs
		// once, by the name the controller gives it, to report the disk's uid
		// as part of its identity. Never listed — a host that had to
		// enumerate PVCs would be reading other workspaces' disks.
		expect(byResource.get('persistentvolumeclaims')).toEqual(new Set(['get']))
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

	it('grants get on persistentvolumeclaims in the core apiGroup', () => {
		// The core group, because that is where PVCs live, and separately from
		// the pods rule so the verb sets cannot drift into each other: a `list`
		// added to pods must never silently become a `list` on disks.
		const rules = role.rules as Record<string, unknown>[]
		const rule = rules.find((r) => (r.resources as string[]).includes('persistentvolumeclaims'))
		expect(rule, 'no rule grants persistentvolumeclaims').toBeDefined()
		expect(rule?.apiGroups).toEqual([''])
		expect(rule?.verbs).toEqual(['get'])
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
