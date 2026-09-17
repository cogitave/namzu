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

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

import { DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY } from '../../src/backends/kubernetes/egress-policy.js'
import { PER_SANDBOX_POLICY_NAME_PREFIX } from '../../src/backends/kubernetes/per-sandbox-policy.js'
// The pool-only path's own verb list, imported from the backend rather than
// copied here. This constant pins `rbac-claimant.yaml` to a list — and the
// call-site scan further down reads the path's own sources and pins that list
// to the CODE, which is the half a manifest comparison cannot see. Together
// they make a verb added to (or quietly needed by) a path no unit test can
// reach fail here rather than on a cluster. See that module's comment, and the
// scan's header for which case catches which direction.
import { KUBERNETES_CLAIMANT_RBAC_RULES } from '../../src/backends/kubernetes/rbac.js'
// The apiGroups, straight off the module that builds every path the backend
// requests — so the scan's builder map and the constant cannot disagree about
// which group a resource lives in.
import {
	ADMISSION_REGISTRATION_API_GROUP,
	CILIUM_NETWORK_POLICY_API_GROUP,
	CORE_NETWORK_POLICY_API_GROUP,
	SANDBOX_API_GROUP,
	SANDBOX_EXTENSIONS_API_GROUP,
} from '../../src/backends/kubernetes/objects.js'

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
		'rbac-per-sandbox-egress.yaml',
		'validatingadmissionpolicy-cilium.yaml',
		'rbac-claimant.yaml',
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
		'rbac-per-sandbox-egress.yaml',
		'validatingadmissionpolicy-cilium.yaml',
		'rbac-claimant.yaml',
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

/**
 * One Role's grants, keyed by `resource`.
 *
 * The key is the resource alone because one resource per rule is the shape
 * both files are written in — so a resource reaching this map twice is
 * already a surprise, and it is treated as one: the verbs are UNIONED rather
 * than last-one-wins (the assertions compare whole sets, and dropping either
 * half would make them pass by accident), and the apiGroups are COLLECTED
 * into a set rather than taking `apiGroups[0]`. Recording only the first
 * group would compare asymmetrically the day a rule carries two of them or a
 * resource is granted from a second group; collecting them makes the
 * comparison in `rbac-claimant.yaml`'s exact-match case fail and name the
 * resource instead. A resource granted from two groups wants a composite key,
 * and this comment is where the next author finds that out.
 */
function grantsByResource(
	role: Record<string, unknown>,
): Map<string, { apiGroups: Set<string>; verbs: Set<string> }> {
	const grants = new Map<string, { apiGroups: Set<string>; verbs: Set<string> }>()
	for (const rule of (role.rules as Record<string, unknown>[]) ?? []) {
		const verbs = new Set((rule.verbs as string[]) ?? [])
		const apiGroups = (rule.apiGroups as string[]) ?? []
		for (const resource of (rule.resources as string[]) ?? []) {
			const existing = grants.get(resource)
			if (existing === undefined) {
				grants.set(resource, { apiGroups: new Set(apiGroups), verbs })
				continue
			}
			for (const verb of verbs) existing.verbs.add(verb)
			for (const apiGroup of apiGroups) existing.apiGroups.add(apiGroup)
		}
	}
	return grants
}

describe('rbac-claimant.yaml', () => {
	const docs = loadYaml('rbac-claimant.yaml') as Record<string, unknown>[]
	const serviceAccount = docs.find((d) => d.kind === 'ServiceAccount') as Record<string, unknown>
	const role = docs.find((d) => d.kind === 'Role') as Record<string, unknown>
	const roleBinding = docs.find((d) => d.kind === 'RoleBinding') as Record<string, unknown>
	const grants = grantsByResource(role)
	// The other Role this directory ships is this grant's CEILING, not its
	// source: the whole point of the claimant Role is to be a strictly smaller
	// grant than rbac.yaml's, so it may only ever narrow.
	const widerRole = loadYaml('rbac.yaml').find((d) => d.kind === 'Role') as Record<string, unknown>
	const wider = grantsByResource(widerRole)

	it('is a namespaced Role, with one ServiceAccount named three times over', () => {
		expect(role.kind).toBe('Role')
		expect((role.metadata as Record<string, unknown>).namespace).toBeTruthy()
		const name = (role.metadata as Record<string, unknown>).name
		expect((serviceAccount.metadata as Record<string, unknown>).namespace).toBe(
			(role.metadata as Record<string, unknown>).namespace,
		)
		expect((serviceAccount.metadata as Record<string, unknown>).name).toBe(name)
		const subjects = roleBinding.subjects as Record<string, unknown>[]
		expect(subjects).toHaveLength(1)
		expect(subjects[0]?.kind).toBe('ServiceAccount')
		expect(subjects[0]?.name).toBe(name)
		expect((roleBinding.roleRef as Record<string, unknown>).name).toBe(name)
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

	it("grants exactly the pool-only path's verbs, from the backend's own constant", () => {
		// The half of the pin the two manifest files can settle on their own:
		// the Role grants exactly the constant, no more and no less. Neither
		// file can see the CODE, though — that is the scan below ("the
		// pool-only path's call sites"), which reads the path's sources and
		// fails on a request the constant does not cover. Together they make a
		// verb added to the pool-only path fail a test naming the resource,
		// instead of surfacing as a `403` in a host's log.
		const expected = new Map(
			KUBERNETES_CLAIMANT_RBAC_RULES.map((rule) => [
				rule.resource,
				{ apiGroup: rule.apiGroup, verbs: [...rule.verbs].sort() },
			]),
		)
		expect([...grants.keys()].sort()).toEqual([...expected.keys()].sort())
		for (const [resource, grant] of expected) {
			const actual = grants.get(resource)
			// Exactly one apiGroup, compared as a set: a second one would mean
			// this resource is granted from two groups and the resource-only key
			// no longer identifies a grant — see `grantsByResource`.
			expect([...(actual?.apiGroups ?? [])], `${resource} apiGroup`).toEqual([grant.apiGroup])
			expect([...(actual?.verbs ?? [])].sort(), `${resource} verbs`).toEqual(grant.verbs)
		}
	})

	it("is a strict subset of rbac.yaml's grants: narrower per resource, and fewer of them", () => {
		for (const [resource, grant] of grants) {
			const ceiling = wider.get(resource)
			expect(ceiling, `rbac.yaml grants nothing on ${resource}`).toBeDefined()
			for (const verb of grant.verbs) {
				expect(
					ceiling?.verbs.has(verb),
					`${resource}: rbac.yaml does not grant ${verb}`,
				).toBe(true)
			}
		}
		// Strictly: at least one verb the wider Role carries is NOT here, and
		// the ones that matter most are named rather than counted.
		const total = (map: Map<string, { verbs: Set<string> }>): number =>
			[...map.values()].reduce((sum, grant) => sum + grant.verbs.size, 0)
		expect(total(grants)).toBeLessThan(total(wider))
		expect(grants.get('sandboxes')?.verbs.has('create')).not.toBe(true)
		expect(wider.get('sandboxes')?.verbs.has('create')).toBe(true)
	})

	it('grants no write verb on any policy resource', () => {
		// A host that could rewrite a NetworkPolicy could open the agent port
		// every create spends a policy read proving closed. The exact-match
		// case above would pass a constant that granted it; this case would not.
		for (const resource of ['networkpolicies', 'ciliumnetworkpolicies']) {
			const verbs = grants.get(resource)?.verbs ?? new Set<string>()
			for (const write of ['create', 'update', 'patch', 'delete', 'deletecollection']) {
				expect(verbs.has(write), `${resource} grants ${write}`).toBe(false)
			}
		}
	})

	it('grants `get` and nothing else on sandboxes — the escalation this file removes', () => {
		// `sandboxes: create` is not a convenience on a namespace running the
		// privileged workspace template: it is an arbitrary privileged pod.
		expect([...(grants.get('sandboxes')?.verbs ?? [])]).toEqual(['get'])
	})

	it('reaches for no pod subresource: the agent is a socket the guest serves, not exec', () => {
		for (const resource of grants.keys()) {
			expect(resource, 'a pod subresource is granted').not.toMatch(/^pods\//)
		}
		expect(grants.has('pods')).toBe(true)
	})

	it("grants neither sandboxtemplates nor persistentvolumeclaims: both reads are off this path", () => {
		// The template read sits in the pool-LESS branch of the create body and
		// a workspace handle's disk read has nothing to iterate on a claim, so
		// both are omissions rather than oversights — asserted so a future
		// "just in case" grant fails here, where the reason is written down.
		expect(grants.has('sandboxtemplates'), 'sandboxtemplates is granted').toBe(false)
		expect(wider.has('sandboxtemplates'), 'rbac.yaml still grants it').toBe(true)
		expect(grants.has('persistentvolumeclaims')).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// The call-site scan: what backs `KUBERNETES_CLAIMANT_RBAC_RULES`
// ---------------------------------------------------------------------------
//
// The constant and `rbac-claimant.yaml` are compared to EACH OTHER above, and
// that comparison can catch neither of them drifting from the CODE: a request
// added to the pool-only path in `index.ts`, with neither file touched, moves
// no assertion in this file. So this scan reads the path's own sources and
//
//   - reads the DIRECTORY, not a list: every `.ts` under
//     `src/backends/kubernetes/` that reaches the client — calling
//     `client.request(…)` itself in either spelling this scan reads, the
//     literal one or the computed `client['request']`, or NAMING a wrapper
//     `REQUEST_WRAPPERS` declares, all on comment-blanked text (the predicate
//     is `claimPathReach` below, and it is exactly those three halves) — is
//     either scanned or declared off the path with a reason (see
//     CLAIM_PATH_SOURCE_EXEMPTIONS and the case it closes below), so a file
//     cannot be outside the pin by not being named in it;
//   - resolves every request it reads to a `(apiGroup, resource, verb)` triple
//     through the path builders `objects.ts` declares, and FAILS on anything it
//     cannot resolve — an undeclared builder, a path expression it cannot
//     follow, a method with no verb, a builder call with something appended to
//     it, a path that is a parameter of a body the scan cannot see the call
//     sites of, a wrapper REQUEST_WRAPPERS names that no scanned file declares.
//     New code has to declare itself (the builder map, or the wrapper map)
//     rather than escape the pin by being unreadable;
//   - attributes each request to the function body it is LEXICALLY inside,
//     matched by braces, rather than to the last declaration written above it
//     (the case below), and FAILS a request that lies in no body it can match
//     instead of naming the wrong one;
//   - asserts the observed triples are EXACTLY the constant's, plus the four
//     the pool-LESS branch issues and this grant deliberately declines — each
//     of those declared at the ONE call site that issues it, so a second
//     request issuing one of them fails too.
//
// Three directions, and which case catches which:
//
//   - **source adds a verb** — a call on the claim path with no matching rule
//     — fails "observes no verb the constant does not grant", naming the file,
//     the line and the resource.
//   - **the constant adds a verb** — a rule nothing issues — fails "observes
//     every verb the constant grants", so the grant cannot grow past the code
//     even when the YAML is grown with it.
//   - **the YAML drifts from the constant** — the one direction these two
//     files can see by themselves — fails the exact-match case in the
//     `rbac-claimant.yaml` block above.
//
// Seven requests that passed this file GREEN before it read them, each run
// against the real test and then reverted. They are why the checks above are
// the shape they are, and each one's assertion is named:
//
//   - **a builder call with anything appended.** `resolvePathExpression` used
//     to match `/^([A-Za-z_$][\w$]*)\s*\(/`, which is anchored at the START
//     only: `client.request('GET', podPath(ns, name) + '/log', …)` at
//     index.ts:2252 resolved as `pods: get` — the path is really
//     `/api/v1/namespaces/<ns>/pods/<name>/log`, which RBAC authorizes as the
//     SEPARATE `pods/log` resource this grant does not carry, so a claimant
//     would `403` on exactly the failure the change claims to catch. The
//     template-literal spelling of that path has always failed, so two
//     spellings of one path disagreed. Now: the builder branch walks to the
//     builder's own `)` and requires nothing but whitespace after it, and both
//     spellings fail.
//   - **a request in a file the scan does not read.** `CLAIM_PATH_SOURCES` is
//     a four-name literal; nothing read the directory, and `workspace.ts`
//     carries thirteen `.request` mentions and was never opened, so a request
//     planted there passed green while the same triple planted in `index.ts`
//     failed by name. Now: the file set is the directory — see the
//     "the files this scan reads" case, which fails on any `.ts` file under
//     `src/backends/kubernetes/` that reaches the client in any of the senses
//     the first bullet above states (its own `client.request(…)`, the computed
//     `client['request']` spelling of it, or a name `REQUEST_WRAPPERS`
//     declares) and is declared neither in CLAIM_PATH_SOURCES nor in
//     CLAIM_PATH_SOURCE_EXEMPTIONS.
//   - **a request through a wrapper, in a file the scan does not read.** The
//     predicate above used to be the `/\.request\b/` literal ALONE, under
//     prose that said "reaches the client": a file issuing its request through
//     `listPolicies` — the wrapper that takes its path as an argument —
//     contains no `.request`, and `triplesThroughWrapper` reads call sites in
//     `CLAIM_PATH_SOURCES` only, so the file its call sits in was neither
//     scanned nor required to be declared. A planted `capacity-v2.ts` beside
//     the scanned sources calling `listPolicies` with the path
//     `/api/v1/namespaces/<ns>/secrets` — a request to `secrets`, which this
//     Role does not grant — left all 53 cases green. Now: that half is in the
//     predicate, so the same plant fails by name; and declaring such a file
//     scanned is a real decision rather than a formality, since the scan then
//     resolves the argument it hands the wrapper (the same plant added to
//     `CLAIM_PATH_SOURCES` fails at that path).
//   - **a second wrapper written as `const … = async (…) =>`.** Attribution
//     used to be `enclosingFunction`, the last `function NAME(` textually
//     above the request, with no body matching. A wrapper placed after
//     `listPolicies` — `const probeCollectionRead = async (client, path,
//     signal) => { await client.request('GET', path, …) }` — was therefore
//     attributed to `listPolicies`, whose REQUEST_WRAPPERS parameter is named
//     `path`, and passed green; renaming the parameter made it fail, naming a
//     function the request is not in. Now: bodies are registered with their
//     offsets and requests are attributed to the innermost one containing them,
//     so `path` is a parameter of `probeCollectionRead` — a body
//     REQUEST_WRAPPERS does not declare — and the failure names that body.
//   - **a declared wrapper whose declaration is not a `function`.** The map's
//     remedy is the sentence its own failure message prescribes — "declare `X`
//     in REQUEST_WRAPPERS … its call sites are then resolved too" — and the
//     declaration was read back through a `function NAME(` regex of this
//     function's own, while every OTHER half of the scan registers bodies
//     through `functionBodies`. So a wrapper written `export const
//     listSecretsV2 = async (client, path, signal) => { … }` was in no
//     declaration that lookup could find: `triplesThroughWrapper` returned the
//     empty list in silence, the call sites handing it a path were never
//     resolved, and the request they issue was invisible to every case here —
//     53/53 green, where the IDENTICAL plant written `export async function
//     listSecretsV2(` failed by name. Now: the declaration is found through
//     `functionBodies` (so all three shapes it registers count, and the
//     declared parameter's POSITION is the one that body's own parameter list
//     gives it), a wrapper NO scanned file declares fails by name, and
//     `resolveIdentifier` falls through to its own emptiness failure instead of
//     returning the wrapper half's empty list unguarded. The same plant
//     declared in the EXEMPT `k8s-client.ts` — a file this scan does not read,
//     so no scanned body reaches the declaration at all, and no scanned request
//     even drives the entry — fails the harvest's own check that every
//     REQUEST_WRAPPERS entry is DECLARED in a file this scan reads, the half
//     that makes declaring a wrapper reach anything at all.
//   - **a file that reaches the client through a computed `['request']`.** The
//     predicate's first half was `/\.request\b/`, which
//     `client['request']('GET', …)` contains no dot for — under a doc claiming
//     the opposite ("one that reaches it through a computed access is"), true
//     of the SCAN, which refuses that spelling by line, and false of the
//     predicate that decides which files the scan reads. A planted
//     `capacity-computed.ts` holding only that call sat in neither
//     CLAIM_PATH_SOURCES nor CLAIM_PATH_SOURCE_EXEMPTIONS and every case
//     stayed green; adding it to CLAIM_PATH_SOURCES then failed on the
//     computed-access rule, which is the one rule the file had to be scanned to
//     meet — the guard firing only for files already scanned. Now: half one is
//     both spellings, so such a file fails by name until it is declared, and
//     declared scanned it fails on the rule that refuses the spelling.
//   - **a name written a second path.** The two spellings above are how a path
//     is written INTO a request; this is how one arrives through a NAME the
//     scan resolves instead, and it was invisible for as long as
//     `declaredInitializers` has existed — it reads a `const`/`let`/`var NAME
//     = …` initializer and no other write to that name, so a planted
//     `capacity-v12.ts` (a `readClaimCapacity(client, namespace, collection,
//     signal)` body, added to CLAIM_PATH_SOURCES) whose lines 16 to 19 are
//
//         16  let path = podCollectionPath(namespace)
//         17  if (collection === 'logs') { path = `${podCollectionPath(namespace)}/log` }
//         18  // The request, which sends the subresource.
//         19  const list = await client.request('GET', path, undefined, signal)
//
//     left all 53 cases green — the request reaches `pods/log`, which RBAC
//     authorizes as its own resource, while the resolution reports the
//     initializer's `pods list`. That is the SAME escape the appended-suffix
//     case closes, in the one spelling that case cannot see: what follows the
//     builder there is a statement end rather than the builder's own `)`, and
//     it was the argument's spelling that failed by name while the assigned one
//     passed. Now: `resolveIdentifier` refuses to resolve a name the source
//     writes a second time — `reassignmentsOf`, below — naming the file, the
//     line and the write, and telling the author to give the second path its own
//     declaration or its own builder. It reads four spellings, and reads each of
//     them WHEREVER it is written rather than only where it opens a statement:
//     a plain assignment (`path = …`), a compound one (`path += '/log'`), a loop
//     binding (`for (path of …)`), and a destructuring target whose name it
//     carries (`({ path } = …)`, `[first, path] = …`). Measured: the plant above
//     fails at its own line (`capacity-v12.ts:19`, naming `line 17`); so do
//     `path += '/log'`, `;({ path } = source)` and `for (path of names)`; and so
//     do the branch spellings a statement-start anchor could not see —
//     `if (collection === 'logs') path = …` appended to `index.ts` fails at
//     `index.ts:2526`, naming `line 2525`, and so do the braced and the
//     destructuring forms of that same line (`if (…) { path = … }`,
//     `if (…) ({ path } = …)`). The ONE `=` that is not a second write is the
//     declaration clause's, read off the declaration's OWN line: `const path = …`
//     is the write the scan resolves a name through, `for (let path = …; …)`
//     opens with its keyword too, and a destructuring DECLARATION (`const
//     { path } = …`, `const [first, path] = …`) is a binding the list below
//     already carries rather than a write to the name being resolved — so a
//     declaration is stepped over and a write beside it on the same line is
//     not. The same rule is read for BOTH halves of a name's resolution, and the
//     second half has the same escape: a WRAPPER's own path parameter is
//     resolved through its call sites, so a body that rewrites the parameter
//     before requesting resolves every caller's argument to a path the request
//     does not send — a wrapper planted appending `/log` to the path it was
//     handed, called with a real builder, left all 53 cases green with the
//     subresource reported as its parent, and fails by name now, in the compound
//     spelling and in the one a branch opens alike.
//     That guard is by NAME in the file it resolves in rather than by scope, as
//     the resolution it guards is: an assignment to a same-named local in an
//     UNRELATED function refuses this request too — a false refusal where a
//     resolution would have been right, never an escape.
//
// What this scan still CANNOT see, so that no sentence above reads stronger
// than the code that backs it. This is the FULL list: `rbac.ts`,
// `k8s/manifests/rbac-claimant.yaml`, `docs/sdk/kubernetes-sandbox.md`,
// `docs/log.md` and the changeset each carry the SHORT form of it and say which
// bullets they leave out — the assembly bullet below is the one no short form
// carries, and `rbac.ts` leaves the cluster one too, which the other four state
// (the manifest under NOT MEASURED HERE).
//
//   - **the files it does not read.** `workspace.ts` (the workspace API),
//     `k8s-client.ts` (the HTTP client) and `transport.ts` (the wire protocol)
//     are declared off the pool-only path and their requests are NOT resolved
//     to triples — including a CALL SITE of a REQUEST_WRAPPERS wrapper in one
//     of them, which is read from the scanned files only. That a claimant host
//     never issues them is a claim about the DEPLOYMENT — `warmPoolName` set,
//     no `Sandbox` created by that host — and this test does not measure it.
//   - **a wrapper reached by a name this predicate does not know.** The file
//     predicate matches a wrapper's NAME in the file's text, not the wrapper's
//     identity: a file that reaches `listPolicies` by ANOTHER name — an import
//     of a re-export (`listEveryPolicy` for `listPolicies`), or a call to a
//     helper one level further out that itself calls the wrapper — mentions
//     none of the predicate's halves, so it is neither scanned nor required to
//     be declared. The chain followed here is one name long, from
//     `REQUEST_WRAPPERS` to the files that spell it.
//   - **an expression-bodied arrow's own parameters.** Bodies are matched by
//     braces; `(path) => someClient.request('GET', path, …)` has none, so a
//     parameter it shadows is invisible and the request attributes to the
//     braced body around it. Every wrapper that exists today is braced.
//   - **a body whose brace the scan cannot reach** — a class method, or an
//     object literal's shorthand method, declared INSIDE one of these bodies,
//     or a header shape other than the three this file reads. A request in a
//     body it did not register is attributed to the body that ENCLOSES it, so
//     the nested body's own parameters are invisible and a path there resolves
//     through the enclosing body's names instead (measured: a shorthand method
//     placed inside `release` in `index.ts` had its `path` reported as neither
//     declared in `index.ts` nor a `REQUEST_WRAPPERS` parameter of `release`).
//     A TOP-LEVEL method is not this case: it lies in no body the scan
//     registered at all, so it fails outright (run against a class holding one
//     request, which the scan refused by line).
//   - **a destructuring pattern nested inside another.** A target is read
//     against a group that closes with `=`, and a group containing a brace or a
//     bracket of its own is not one: `({ a: { path } } = …)` and `[[path]] = …`
//     are read by NEITHER the destructuring spelling nor the plain one (nothing
//     in them spells `path =`), so a request through `path` there resolves
//     through a same-named declaration elsewhere in the file instead. Measured:
//     the `capacity-v12.ts` above with `;({ a: { path } } = { a: { path:
//     `${podCollectionPath(namespace)}/log` } })` as its line 17 leaves all 53
//     cases green. A bracket group MAY hold a brace (`[{ path }] = …` is read),
//     and the braces are matched without nesting on purpose — a `{` that opens a
//     BODY would otherwise run to the first `}` below it, which is the closing
//     brace of the next pattern, and it is that over-match the missing nesting
//     buys off.
//   - **a path assembled by an operation the scan does not model**: a variable
//     holding part of a path, `.join('/')`, a helper in another module. The
//     appended-suffix case above is closed in BOTH spellings a request can carry
//     it in — as the argument, and through a name the source writes a second
//     time, in any of `reassignmentsOf`'s four spellings — so what this bullet
//     still holds is the assembly itself: a path whose pieces are computed by an
//     operation this scan does not model is not resolved, and a variable holding
//     part of one is not enough to resolve through.
//   - **a binding this scan does not read, whatever writes it.** The assignment
//     guard reads WRITES to a name it is resolving, in the one file, by name
//     rather than by scope; a BINDING it registers nowhere shadows nothing here.
//     A destructuring parameter is the shape to know: `function f({ path })`
//     leaves its positional slot `undefined` (the slot keeps its place, the name
//     is not read out of the pattern), so it matches no name — a request through
//     it resolves through a same-named declaration elsewhere in the file, or
//     fails — and a `catch (path)` or a destructuring declaration that is not
//     the declaration `declaredInitializers` matches is the same shape. The one
//     place that shape reaches the assignment guard is a parameter carrying a
//     DEFAULT: `function f({ path } = {})` and `function f(path = …)` are
//     written with an `=`, so they refuse the request rather than resolving it —
//     a refusal, where the bare pattern above resolved or failed. A value
//     that reaches the request from ANOTHER module is outside the guard for the
//     same structural reason: the guard reads this file's text, so a write made
//     to an exported binding from elsewhere is not in it, and neither is a name
//     replaced across files.
//   - **the cluster.** Nothing here contacts an API server, so no claim about
//     what a live `Role` permits is measured — only what this backend issues.
//
// The three most recent fixes recorded above did not REMOVE a bullet from that
// list — an entry here is a shape this scan still does not read at all (a file,
// a name, an arrow, a body, an expression, a binding, a pattern, the cluster),
// while a fix was a hole in the scan's own mechanism. Two of them were exactly
// that: a declaration lookup that could not see the shape it promised to read,
// and a file predicate missing a spelling of the call it was written to catch.
// The assignment guard is the third, and it MOVED a bullet rather than leaving
// it whole: "a variable holding part of a path" was true of a variable holding
// a WHOLE one that a later write replaced, which is a write this scan now
// reads, so the bullet says what is left of it — and the nesting its
// destructuring spelling does not read, measured green above, is written down
// as a bullet of its own rather than left for a reader to discover.

/** One `(apiGroup, resource, verb)` triple, as RBAC decides a request. */
interface ClaimPathTriple {
	readonly apiGroup: string
	readonly resource: string
	readonly verb: string
}

/** An observed triple and the call site that issued it, for failure messages. */
interface ObservedTriple {
	readonly triple: ClaimPathTriple
	readonly file: string
	readonly line: number
	/**
	 * The function body the call sits IN — half of a call site's identity, and
	 * a LEXICAL one: the innermost declaration whose braces contain the call
	 * (see `functionBodies`), never the nearest declaration textually above it.
	 * For an anonymous arrow body it is the position that body opens at.
	 */
	readonly enclosing: string
}

/**
 * Which shape of path a builder addresses. RBAC's verb for a `GET` depends on
 * it — `list` reads a collection, `get` reads one object — and that split is
 * the whole reason `sandboxes: list` is withheld from the claimant Role while
 * `sandboxes: get` is granted.
 */
type PathKind = 'collection' | 'object'

/**
 * Every path builder `objects.ts` declares, against the resource it addresses.
 * The apiGroups are the module's own constants rather than a second copy of
 * the strings, so a builder's group and the constant's cannot disagree
 * silently. Declared rather than derived from the builder bodies on purpose: a
 * builder this map does not know fails the scan below, which is the forcing
 * function for a new resource — the alternative (parse the template literal)
 * would quietly follow any string it found.
 */
const PATH_BUILDERS: Readonly<
	Record<string, { readonly apiGroup: string; readonly resource: string; readonly kind: PathKind }>
> = {
	claimCollectionPath: {
		apiGroup: SANDBOX_EXTENSIONS_API_GROUP,
		resource: 'sandboxclaims',
		kind: 'collection',
	},
	claimPath: { apiGroup: SANDBOX_EXTENSIONS_API_GROUP, resource: 'sandboxclaims', kind: 'object' },
	claimListPath: {
		apiGroup: SANDBOX_EXTENSIONS_API_GROUP,
		resource: 'sandboxclaims',
		kind: 'collection',
	},
	warmPoolPath: {
		apiGroup: SANDBOX_EXTENSIONS_API_GROUP,
		resource: 'sandboxwarmpools',
		kind: 'object',
	},
	sandboxCollectionPath: { apiGroup: SANDBOX_API_GROUP, resource: 'sandboxes', kind: 'collection' },
	sandboxPath: { apiGroup: SANDBOX_API_GROUP, resource: 'sandboxes', kind: 'object' },
	sandboxTemplatePath: {
		apiGroup: SANDBOX_EXTENSIONS_API_GROUP,
		resource: 'sandboxtemplates',
		kind: 'object',
	},
	// The core group is the empty string, which is what RBAC's own rule writes.
	persistentVolumeClaimPath: { apiGroup: '', resource: 'persistentvolumeclaims', kind: 'object' },
	podPath: { apiGroup: '', resource: 'pods', kind: 'object' },
	podCollectionPath: { apiGroup: '', resource: 'pods', kind: 'collection' },
	podListPath: { apiGroup: '', resource: 'pods', kind: 'collection' },
	networkPolicyCollectionPath: {
		apiGroup: CORE_NETWORK_POLICY_API_GROUP,
		resource: 'networkpolicies',
		kind: 'collection',
	},
	networkPolicyPath: {
		apiGroup: CORE_NETWORK_POLICY_API_GROUP,
		resource: 'networkpolicies',
		kind: 'object',
	},
	ciliumNetworkPolicyCollectionPath: {
		apiGroup: CILIUM_NETWORK_POLICY_API_GROUP,
		resource: 'ciliumnetworkpolicies',
		kind: 'collection',
	},
	ciliumNetworkPolicyPath: {
		apiGroup: CILIUM_NETWORK_POLICY_API_GROUP,
		resource: 'ciliumnetworkpolicies',
		kind: 'object',
	},
	// The per-sandbox fence's own objects: both are CLUSTER-scoped
	// `admissionregistration.k8s.io/v1` resources, read by
	// `per-sandbox-policy.ts` before a write and never written by this
	// backend. They are in this map because every `*Path` builder
	// `objects.ts` declares has to be, whether or not a SCANNED file
	// reaches it — the case below is the set equality, and the file that
	// uses them is declared off the pool-only path.
	validatingAdmissionPolicyPath: {
		apiGroup: ADMISSION_REGISTRATION_API_GROUP,
		resource: 'validatingadmissionpolicies',
		kind: 'object',
	},
	validatingAdmissionPolicyBindingPath: {
		apiGroup: ADMISSION_REGISTRATION_API_GROUP,
		resource: 'validatingadmissionpolicybindings',
		kind: 'object',
	},
}

/**
 * The one indirection between a request and its path: a function in these
 * sources whose path is an ARGUMENT. `listPolicies` is the only one today —
 * `index.ts` and `egress-policy.ts` both list through it — and the scan
 * follows it by name: the declared parameter is located in the function's OWN
 * DECLARATION, in any of the shapes `functionBodies` registers a body from (a
 * `function NAME(…)` and a `const NAME = … =>` are the same declaration to
 * this map, so the remedy works whichever an author writes), and every call
 * site's argument AT THAT POSITION is resolved.
 *
 * A request whose path is a parameter of a function NOT declared here fails
 * the scan. That is the point: a second wrapper has to say so — and so does a
 * wrapper whose declaration this scan cannot reach, since the declaration is
 * where its call sites are found (see `triplesThroughWrapper`, and the
 * harvest's check that every entry here is driven by a request it reads).
 */
const REQUEST_WRAPPERS: Readonly<Record<string, string>> = { listPolicies: 'path' }

/**
 * A triple outside the constant, and the ONE call site that issues it.
 */
interface PoolLessEscape {
	readonly triple: ClaimPathTriple
	readonly file: string
	readonly enclosing: string
}

/**
 * The pool-LESS branch's own triples — issued from the same files, and
 * deliberately NOT granted to a claimant: a host that takes any of them is
 * creating or reading a `Sandbox` of its own, which is exactly the deployment
 * `rbac-claimant.yaml`'s header sends to `rbac.yaml` instead.
 *
 *  - `sandboxes` `create`/`patch`/`delete` — `createPath`, `renew` and
 *    `release` each take the CLAIM builder when `config.warmPoolName` is set
 *    and the `Sandbox` builder when it is not; the claim halves are in the
 *    constant, these three are the other halves.
 *  - `sandboxtemplates: get` — `readSandboxTemplate`, read by the pool-less
 *    branch of the create body alone.
 *
 * Declared per CALL SITE rather than per triple, and compared exactly: the
 * scan must find each of these at the one site named here and nowhere else,
 * so a second request issuing `sandboxes: patch` — the escalation this whole
 * change is about, on the claim path — is not excused by the entry that
 * already covers the pool-less half of `renew`. An entry with no call site at
 * all fails too, so the list cannot decay into a standing licence.
 */
const POOL_LESS_BRANCH_ONLY: readonly PoolLessEscape[] = [
	{
		// The create POST, and the pool-LESS half's renew and release each take
		// the `Sandbox` builder when `config.warmPoolName` is unset. `createPath`
		// is built in `acquireKubernetesSandbox`'s own body; `ownedPath` is built
		// in the two arrows that function declares, so each is declared at the
		// body the scan attributes it to — the innermost one containing it.
		triple: { apiGroup: SANDBOX_API_GROUP, resource: 'sandboxes', verb: 'create' },
		file: 'index.ts',
		enclosing: 'acquireKubernetesSandbox',
	},
	{
		triple: { apiGroup: SANDBOX_API_GROUP, resource: 'sandboxes', verb: 'patch' },
		file: 'index.ts',
		enclosing: 'renew',
	},
	{
		triple: { apiGroup: SANDBOX_API_GROUP, resource: 'sandboxes', verb: 'delete' },
		file: 'index.ts',
		enclosing: 'release',
	},
	{
		triple: { apiGroup: SANDBOX_EXTENSIONS_API_GROUP, resource: 'sandboxtemplates', verb: 'get' },
		file: 'index.ts',
		enclosing: 'readSandboxTemplate',
	},
]

/** Where the pool-only path lives. Nothing else is read. */
const CLAIM_PATH_SOURCE_DIR = join(HERE, '../../src/backends/kubernetes')

/**
 * The pool-only path's own files — the ones whose requests this scan resolves
 * to triples. The list is compared to the DIRECTORY in "the files this scan
 * reads" below, so it is a declaration about the directory rather than a
 * substitute for reading it.
 */
const CLAIM_PATH_SOURCES = [
	'index.ts',
	'objects.ts',
	'ingress-policy.ts',
	'egress-policy.ts',
] as const

/** A directory entry declared out of scope, with the reason it is out of scope. */
interface SourceDeclaration {
	readonly file: string
	readonly reason: string
}

/**
 * Files under `CLAIM_PATH_SOURCE_DIR` that REACH the client — `claimPathReach`
 * below, in full: their own `client.request(…)`, or a name `REQUEST_WRAPPERS`
 * declares — and are NOT part of the pool-only path. Declared rather than left
 * out: silence is how the scan comes to read a set that stopped covering the
 * path — a request planted in `workspace.ts` passed this file green while the
 * same triple planted in `index.ts` failed by name. Each entry says why the
 * file cannot be on a claimant host's path, and the case below asserts every
 * one of them still reaches the client, so the list cannot decay into a
 * standing licence to ignore a file. A file that IS on the pool-only path
 * belongs in CLAIM_PATH_SOURCES, not here.
 */
const CLAIM_PATH_SOURCE_EXEMPTIONS: readonly SourceDeclaration[] = [
	{
		file: 'k8s-client.ts',
		reason:
			'the API client every scanned call goes through, not a caller: it owns `request()` and its own `https.request(` is the HTTPS call underneath it, which is no Kubernetes resource path and has no `(apiGroup, resource, verb)` triple to resolve. The path arrives as this method\'s argument, and it is the argument the scan reads.',
	},
	{
		file: 'transport.ts',
		reason:
			'the wire protocol under the client — `wire.request(…)` frames a message to the sandbox guest, not a Kubernetes API path. Nothing on it is authorized by the Role this grant describes.',
	},
	{
		file: 'workspace.ts',
		reason:
			'the WORKSPACE backend: a `Sandbox` a host creates, suspends, resumes and deletes itself, plus the claims, pods and PVCs those transitions read. Workspaces are never pooled (docs/sdk/kubernetes-sandbox.md), so a host whose requests this Role is for never reaches it — the deployment that does needs `rbac.yaml`, whose `sandboxes` writes are exactly what this grant withholds. Scanning it here would demand the pool-only constant cover a path that is deliberately not on it.',
	},
	{
		file: 'per-sandbox-policy.ts',
		reason:
			'the per-sandbox egress writer, reached only through `Sandbox.setNetworkPolicy` — present when `config.egress.perSandbox` is configured — which writes, patches and deletes one `CiliumNetworkPolicy` for a single sandbox and reads the cluster-scoped admission fence that bounds each write. Writes on a policy resource and the cluster-scoped read that gates them are exactly what this grant withholds: the opt-in file that adds them, `rbac-per-sandbox-egress.yaml`, binds the default Role\'s ServiceAccount rather than a claimant host\'s. A host holding this Role therefore does not configure that capability and never reaches this file, and scanning it here would demand the pool-only constant cover a path that is deliberately not on it.',
	},
]

/**
 * Directory entries that are not `.ts` files at all — the scan does not
 * recurse, so a source file inside a subdirectory would never be read, and a
 * new subdirectory therefore fails the case below until it is declared here
 * with its reason.
 */
const CLAIM_PATH_DIR_NON_FILES: readonly SourceDeclaration[] = [
	{
		file: '__tests__',
		reason:
			'test sources and their doubles. They drive fake clients rather than an API server, no Role authorizes them, and the package does not publish `k8s/`.',
	},
]

function tripleKey(triple: ClaimPathTriple): string {
	return `${triple.apiGroup}/${triple.resource}:${triple.verb}`
}

function describeTriple(triple: ClaimPathTriple): string {
	const group = triple.apiGroup === '' ? 'core' : triple.apiGroup
	return `${group}/${triple.resource} \`${triple.verb}\``
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length
}

/**
 * `source` with every comment blanked out, character for character: offsets
 * and line numbers survive, every string literal and template is left intact
 * (the method argument is read back out of one), and `// client.request(…)`
 * in a doc comment is no longer a call site. `${…}` inside a template is
 * followed back into code, so a template literal cannot hide one either.
 */
function blankComments(source: string): string {
	const out = source.split('')
	const templateBraces: number[] = []
	let mode: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
	let i = 0
	while (i < source.length) {
		const ch = source[i] as string
		const next = source[i + 1]
		if (mode === 'line') {
			if (ch === '\n') mode = 'code'
			else out[i] = ' '
			i += 1
			continue
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') {
				out[i] = ' '
				out[i + 1] = ' '
				mode = 'code'
				i += 2
			} else {
				if (ch !== '\n') out[i] = ' '
				i += 1
			}
			continue
		}
		if (mode === 'single' || mode === 'double') {
			if (ch === '\\') i += 2
			else {
				if (ch === (mode === 'single' ? "'" : '"')) mode = 'code'
				i += 1
			}
			continue
		}
		if (mode === 'template') {
			if (ch === '\\') i += 2
			else if (ch === '`') {
				mode = 'code'
				i += 1
			} else if (ch === '$' && next === '{') {
				templateBraces.push(0)
				mode = 'code'
				i += 2
			} else i += 1
			continue
		}
		// code
		if (templateBraces.length > 0) {
			if (ch === '{') {
				templateBraces[templateBraces.length - 1] = (templateBraces[templateBraces.length - 1] ?? 0) + 1
				i += 1
				continue
			}
			if (ch === '}') {
				const open = templateBraces[templateBraces.length - 1] ?? 0
				i += 1
				if (open === 0) {
					templateBraces.pop()
					mode = 'template'
				} else {
					templateBraces[templateBraces.length - 1] = open - 1
				}
				continue
			}
		}
		if (ch === '/' && next === '/') {
			mode = 'line'
			out[i] = ' '
			out[i + 1] = ' '
			i += 2
			continue
		}
		if (ch === '/' && next === '*') {
			mode = 'block'
			out[i] = ' '
			out[i + 1] = ' '
			i += 2
			continue
		}
		if (ch === "'") mode = 'single'
		else if (ch === '"') mode = 'double'
		else if (ch === '`') mode = 'template'
		i += 1
	}
	return out.join('')
}

/**
 * `source` with every string literal's BODY blanked out too, character for
 * character — the comment-blanked text a caller has already produced, with
 * offsets and line numbers still intact. This walk needs no state machine of
 * its own: `blankComments` leaves every quote in its result a real string
 * opener, so a quote here is a string and `skipString` finds its end — a
 * templated line (`path = \`…\``) is therefore not read as code by a scan that
 * matches code, while the operator that makes it an assignment is still there.
 * The one assumption it inherits is `blankComments`'s: a regex literal holding
 * a quote would be read as a string, and no scanned source has one.
 */
function blankStringBodies(source: string): string {
	const out = source.split('')
	let i = 0
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			const end = skipString(source, i)
			for (let j = i + 1; j < end; j += 1) out[j] = ' '
			i = end
			continue
		}
		i += 1
	}
	return out.join('')
}

/** The index just past the string literal that opens at `start`. */
function skipString(source: string, start: number): number {
	const quote = source[start] as string
	let i = start + 1
	while (i < source.length) {
		const ch = source[i]
		if (ch === '\\') {
			i += 2
			continue
		}
		if (ch === quote) return i + 1
		if (quote === '`' && ch === '$' && source[i + 1] === '{') {
			i = skipBraced(source, i + 1)
			continue
		}
		i += 1
	}
	return source.length
}

/** The index of the `)` that closes the `(` at `open`, or `undefined`. */
function closeParen(source: string, open: number): number | undefined {
	let depth = 0
	let i = open
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '(') depth += 1
		else if (ch === ')') {
			depth -= 1
			if (depth === 0) return i
		}
		i += 1
	}
	return undefined
}

/** The index just past the `}` that closes the `{` at `start`. */
function skipBraced(source: string, start: number): number {
	let depth = 0
	let i = start
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '{') depth += 1
		else if (ch === '}') {
			depth -= 1
			if (depth === 0) return i + 1
		}
		i += 1
	}
	return source.length
}

/**
 * The source text of each argument of the call whose `(` is at `open`, or
 * `undefined` when the parentheses never close — a shape this scan refuses to
 * guess at.
 */
function callArguments(source: string, open: number): string[] | undefined {
	const args: string[] = []
	let depth = 0
	let start = open + 1
	let i = open + 1
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth += 1
			i += 1
			continue
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0 && ch === ')') {
				args.push(source.slice(start, i))
				return args
			}
			if (depth === 0) return undefined
			depth -= 1
			i += 1
			continue
		}
		if (ch === ',' && depth === 0) {
			args.push(source.slice(start, i))
			start = i + 1
		}
		i += 1
	}
	return undefined
}

/** A quoted literal's value, or `undefined` when the argument is not one. */
function quotedValue(argument: string | undefined): string | undefined {
	// Either quote, because the METHOD is a literal this scan has to read: a
	// call written with double quotes should resolve, not fail as unreadable.
	const match = /^\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*$/.exec(argument ?? '')
	return match?.[1] ?? match?.[2]
}

/** The name of a parameter, out of `path: string` / `signal?: AbortSignal`. */
function parameterName(parameter: string): string | undefined {
	return /^\s*([A-Za-z_$][\w$]*)/.exec(parameter)?.[1]
}

/**
 * A function BODY these sources declare, with the offsets of the body itself.
 *
 * A name alone is not enough. Attribution used to be `enclosingFunction` — the
 * last `function NAME(` textually above the request — which a body written as
 * `const probe = async (…) => { … }` is invisible to: the request inside it
 * resolved through the declaration ABOVE, through that declaration's own
 * `REQUEST_WRAPPERS` parameter, and passed green while describing a function
 * it is not in. So every body is registered with its OFFSETS and a request is
 * attributed to the innermost body that actually contains it.
 */
interface FunctionBody {
	/** The name the declaration gives it; `undefined` for an anonymous arrow body. */
	readonly name: string | undefined
	/** What a failure message and a call site's identity call it. */
	readonly label: string
	/**
	 * The parameter names the body binds, BY POSITION: entry `i` is the name of
	 * the `i`-th parameter, `undefined` where this scan reads no name out of it
	 * (a destructuring pattern). The position is as load-bearing as the name: a
	 * wrapper's declared path parameter is LOCATED by position here and every
	 * call site's argument is read at that position, so a parameter this scan
	 * cannot name keeps its slot instead of shifting the ones after it.
	 *
	 * A request whose path is one of these names is resolved through
	 * `REQUEST_WRAPPERS` or not at all — a parameter SHADOWS a same-named
	 * declaration elsewhere in the file, so falling back to the declaration
	 * would resolve a path this code does not send.
	 */
	readonly parameters: readonly (string | undefined)[]
	/** The `{` (or, for an expression-bodied arrow, the `=>`) that opens it. */
	readonly start: number
	/** The index just past the body — its closing `}`. */
	readonly end: number
}

/** The next index at or after `from` that is not whitespace. */
function nextSignificant(source: string, from: number): number {
	let i = from
	while (i < source.length && /\s/.test(source[i] as string)) i += 1
	return i
}

/** The index just past the `>` that closes the `<` at `start`. */
function skipAngles(source: string, start: number): number {
	let depth = 0
	let i = start
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '<') depth += 1
		else if (ch === '>') {
			depth -= 1
			if (depth === 0) return i + 1
		}
		i += 1
	}
	return source.length
}

/**
 * The `(` that opens a parameter list at or after `from`, skipping the `<…>`
 * generic block a declaration may carry between its name and its parameters.
 */
function parameterListAt(source: string, from: number): number | undefined {
	let i = from
	while (i < source.length) {
		const ch = source[i] as string
		if (/\s/.test(ch)) {
			i += 1
			continue
		}
		if (ch === '<') {
			i = skipAngles(source, i)
			continue
		}
		return ch === '(' ? i : undefined
	}
	return undefined
}

/**
 * The `{` that opens the body of a header whose parameter list closes at
 * `from`, skipping the return type annotation that can sit between them —
 * including an object type (`: { readonly ok: boolean }`) and the second one a
 * union carries (`… | { readonly ok: false }`), which are braces in a type
 * position rather than the body. `undefined` when the header ends without one,
 * which is an overload signature or a shape this scan does not read.
 */
function bodyBraceAt(source: string, from: number): number | undefined {
	let depth = 0
	let previous = ''
	let i = from
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		// A function TYPE's arrow, e.g. `: (signal: AbortSignal) => void`: its
		// `>` closes no generic, so it is consumed as the unit it is.
		if (ch === '=' && source[i + 1] === '>') {
			i += 2
			previous = '>'
			continue
		}
		if (depth > 0) {
			if ('([{<'.includes(ch)) depth += 1
			else if (')]}>'.includes(ch)) depth -= 1
			i += 1
			continue
		}
		if (ch === '{') {
			// In a return type a `{` opens an object TYPE when a type starts
			// here (`: {…}`) or continues after a union/intersection — anywhere
			// else it is the body.
			if (previous === ':' || previous === '|' || previous === '&') {
				i = skipBraced(source, i)
				previous = '}'
				continue
			}
			return i
		}
		if (ch === ';' || ch === ')' || ch === ']' || ch === '}') return undefined
		if ('([<'.includes(ch)) {
			depth += 1
			i += 1
			continue
		}
		if (!/\s/.test(ch)) previous = ch
		i += 1
	}
	return undefined
}

/**
 * The `=>` of an arrow whose parameter list closes at `from`, skipping the
 * return type annotation a typed arrow carries between the two — as in
 * `const release = async (signal?: AbortSignal): Promise<void> => {`.
 * `undefined` when the header ends without one, in which case the structural
 * pass below still registers the body, anonymously and correctly: what it
 * loses is the NAME, never the attribution.
 */
function arrowTokenAt(source: string, from: number): number | undefined {
	let depth = 0
	let i = from
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '=' && source[i + 1] === '>') {
			if (depth === 0) return i
			// Inside a type it is a function type's arrow, not this one's.
			i += 2
			continue
		}
		if (depth === 0) {
			if (ch === '\n' || ch === ';' || ch === '}' || ch === ')' || ch === ']') return undefined
			if ('([{<'.includes(ch)) {
				depth += 1
				i += 1
				continue
			}
			i += 1
			continue
		}
		if ('([{<'.includes(ch)) depth += 1
		else if (')]}>'.includes(ch)) depth -= 1
		i += 1
	}
	return undefined
}

/**
 * Every function body these sources declare, by offsets — read from the three
 * shapes this backend writes: a `function NAME(…)` declaration, a
 * `const NAME = …` assigned to an arrow or a function expression (braced or
 * expression-bodied, the second bounded by the declaration's own end), and any
 * OTHER arrow body, registered structurally and anonymously. The last one is
 * the safety net: an arrow whose declaration this scan could not read is still
 * its own body, so its requests attribute to IT rather than falling through
 * into the declaration above. A body none of the three finds is the residual
 * hole the header comment states.
 */
function functionBodies(source: string): FunctionBody[] {
	const bodies: FunctionBody[] = []
	// Positional on purpose, `undefined` entries included: a wrapper's declared
	// parameter is found by NAME and then read back at its INDEX, so dropping
	// an unreadable parameter would move every parameter after it one slot to
	// the left and silently resolve the wrong argument at a call site.
	const parametersOf = (open: number): readonly (string | undefined)[] =>
		(callArguments(source, open) ?? []).map(parameterName)
	const record = (
		name: string | undefined,
		parameters: readonly (string | undefined)[],
		start: number,
		end: number,
	): void => {
		if (end <= start) return
		bodies.push({
			name,
			label: name ?? `the anonymous function body opening at line ${lineOf(source, start)}`,
			parameters,
			start,
			end,
		})
	}

	// `function NAME(…)`, generics and return type included.
	const declarations = /(?:^|\n)[^\S\n]*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g
	for (const match of source.matchAll(declarations)) {
		const open = parameterListAt(source, match.index + match[0].length)
		if (open === undefined) continue
		const closed = closeParen(source, open)
		if (closed === undefined) continue
		const brace = bodyBraceAt(source, closed + 1)
		if (brace === undefined) continue
		record(match[1] as string, parametersOf(open), brace, skipBraced(source, brace))
	}

	// `const NAME = [async] (…) => …`, `= NAME => …`, `= function …(…)`.
	const assignments =
		/(?:^|\n)[^\S\n]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=[ \t]*/g
	for (const match of source.matchAll(assignments)) {
		const equals = match.index + match[0].lastIndexOf('=')
		// The declaration's own end, which bounds an expression-bodied arrow's
		// body — a body with no brace to match.
		const initEnd = equals + 1 + readInitializer(source, equals).length
		const name = match[1] as string
		let i = source.startsWith('async', match.index + match[0].length)
			? nextSignificant(source, match.index + match[0].length + 'async'.length)
			: nextSignificant(source, match.index + match[0].length)
		// The interface's positional array, in ALL three shapes: a parameter list
		// this scan reads is an `(string | undefined)[]`, and the bare-arrow shape
		// used to hand back a `Set` here instead — so a request inside such a body
		// died on `context.body.parameters.includes is not a function` (and, for a
		// wrapper, on `…indexOf…`), three cases at once, with no file, line or
		// remedy. It failed closed, and `src/` is typechecked away from the shape,
		// but a body this scan registers is a body it promises to resolve, and the
		// promise is a failure message rather than a `TypeError`.
		let parameters: readonly (string | undefined)[]
		let bodyStart: number
		let brace: number | undefined

		if (source.startsWith('function', i)) {
			i = nextSignificant(source, i + 'function'.length)
			if (source[i] === '*') i = nextSignificant(source, i + 1)
			const named = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
			const open = parameterListAt(source, named === null ? i : i + named[0].length)
			if (open === undefined) continue
			const closed = closeParen(source, open)
			if (closed === undefined) continue
			parameters = parametersOf(open)
			brace = bodyBraceAt(source, closed + 1)
			if (brace === undefined) continue
		} else if (source[i] === '(') {
			const closed = closeParen(source, i)
			if (closed === undefined) continue
			const arrow = arrowTokenAt(source, closed + 1)
			if (arrow === undefined) continue
			parameters = parametersOf(i)
			bodyStart = arrow + '=>'.length
			const open = nextSignificant(source, bodyStart)
			brace = source[open] === '{' ? open : undefined
		} else {
			const bare = /^([A-Za-z_$][\w$]*)[ \t]*=>/.exec(source.slice(i))
			if (bare === null) continue
			parameters = [bare[1] as string]
			bodyStart = i + bare[0].length
			const open = nextSignificant(source, bodyStart)
			brace = source[open] === '{' ? open : undefined
		}
		record(
			name,
			parameters,
			brace ?? bodyStart,
			brace === undefined ? initEnd : skipBraced(source, brace),
		)
	}

	// Any other arrow body, structurally: a body without a declaration this
	// scan could read is still a body, never a hole requests fall through.
	for (const match of source.matchAll(/=>/g)) {
		const brace = nextSignificant(source, match.index + '=>'.length)
		if (source[brace] !== '{') continue
		if (bodies.some((body) => body.start === brace)) continue
		record(undefined, [], brace, skipBraced(source, brace))
	}

	return bodies
}

/** The innermost registered body that contains `index`, if any. */
function enclosingBody(
	bodies: readonly FunctionBody[],
	index: number,
): FunctionBody | undefined {
	let innermost: FunctionBody | undefined
	for (const body of bodies) {
		if (index <= body.start || index >= body.end) continue
		if (innermost === undefined || body.start > innermost.start) innermost = body
	}
	return innermost
}

/** How a failure message names a body: its declaration, or where it opens. */
function describeBody(body: FunctionBody): string {
	return body.name === undefined ? body.label : `\`${body.name}\``
}

/** The next line with content after `newline`, comments already blanked. */
function nextContentLine(source: string, newline: number): string | undefined {
	for (const line of source.slice(newline + 1).split('\n')) {
		if (line.trim() !== '') return line.trim()
	}
	return undefined
}

/** Whether the statement being read continues past the newline at `newline`. */
function statementContinues(source: string, head: string, newline: number): boolean {
	const trimmed = head.trim()
	if (trimmed === '') return true
	const last = trimmed[trimmed.length - 1] as string
	if ('=,.(+-*/%&|?:<>!~'.includes(last)) return true
	const next = nextContentLine(source, newline)
	if (next === undefined) return false
	return /^[?:.,)\]}]/.test(next) || /^(&&|\|\||\?\?)/.test(next)
}

/**
 * The initializer of the declaration whose `=` is at `equals`: read to the end
 * of that statement, following a multi-line ternary through to its last
 * branch. A mis-read here is loud — the fragment it produces is not a builder
 * call, so the request that used it fails the scan rather than being skipped.
 */
function readInitializer(source: string, equals: number): string {
	let depth = 0
	let ternaries = 0
	let i = equals + 1
	while (i < source.length) {
		const ch = source[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(source, i)
			continue
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth += 1
			i += 1
			continue
		}
		if (ch === ')' || ch === ']' || ch === '}') {
			if (depth === 0) break
			depth -= 1
			i += 1
			continue
		}
		if (depth === 0) {
			if (ch === '?' && source[i + 1] !== '.' && source[i + 1] !== '?') ternaries += 1
			else if (ch === ':' && ternaries > 0) ternaries -= 1
			else if (ch === ';') break
			else if (ch === '\n' && ternaries === 0) {
				if (!statementContinues(source, source.slice(equals + 1, i), i)) break
			}
		}
		i += 1
	}
	return source.slice(equals + 1, i)
}

/** Every `const`/`let`/`var <name> = …` initializer this source declares. */
function declaredInitializers(source: string, name: string): string[] {
	const pattern = new RegExp(`(?:^|\\n)[^\\S\\n]*(?:const|let|var)\\s+${name}\\s*=`, 'g')
	const found: string[] = []
	for (const match of source.matchAll(pattern)) {
		const equals = match.index + match[0].length - 1
		found.push(readInitializer(source, equals))
	}
	return found
}

/** A statement that writes a name, with the line it sits on, for a failure message. */
interface Reassignment {
	readonly line: number
	readonly text: string
}

/**
 * Every write in this source that ASSIGNS `name` — in the four spellings the
 * paragraph below lists, each read WHEREVER it is written — other than the
 * `const`/`let`/`var` declaration `declaredInitializers` reads, which is a
 * write in a spelling this scan already resolves.
 *
 * `resolveIdentifier` consults it for BOTH halves of a name's resolution — the
 * declaration it reads, and the call sites a REQUEST_WRAPPERS parameter is
 * resolved through — because a name this source rewrites is a name neither half
 * can speak for: a wrapper that appends to the parameter it was handed resolves
 * every caller's argument to a path the request does not send (measured green,
 * with a real builder at the call site).
 *
 * A declaration is not a binding's whole life. `declaredInitializers` reads
 * the initializer and NOTHING ELSE, so a name declared with a builder and then
 * assigned again resolves to the first path while the request sends the second
 * — and a second path that APPENDS to the first is the case this scan's own
 * argument rule refuses by name. Measured, against this file, before this
 * existed: a planted
 *
 *     let path = podCollectionPath(namespace)
 *     if (collection === 'logs') { path = `${podCollectionPath(namespace)}/log` }
 *     const page = await client.request(…, 'GET', path, …)
 *
 * left every case green — the request reached `pods/log`, a subresource RBAC
 * authorizes separately from `pods`, while the resolution reported the
 * initializer's `pods list`. The same concatenation written AS THE ARGUMENT
 * fails by name; only the assignment spelling was invisible. So this is a
 * FAILURE rather than a path to follow: which of two writes a name holds at a
 * request is not something a declaration can answer, and guessing the last one
 * would be as wrong as guessing the first.
 *
 * The four spellings it reads, in comment- and string-blanked text, are each
 * read WHEREVER they are written rather than only where they open a statement:
 * a second write gets no second line, so an anchor at the statement start was
 * itself the hole, and `if (c) path = …` and `if (c) { path = … }` are the same
 * write as one on a line of its own.
 *
 *   - a plain assignment, `path = …`. `(?![=>])` is what keeps `==`, `===` and
 *     an arrow's `path =>` out of it — a bare arrow parameter assigns nothing —
 *     and `(?<![\w$.])` keeps a property write (`binding.path = …`) out.
 *   - a compound assignment, `path += '/log'`, which spells no bare `=` for
 *     those lookaheads to see and was always read wherever it sat.
 *   - a loop binding, `for (path of …)`, the write that spells no `=` at all —
 *     the DECLARING `for (const path of …)` is a fresh binding in the loop's own
 *     scope and is not read here.
 *   - a destructuring assignment whose TARGET names it — `({ path } = …)`,
 *     `[first, path] = …` — read wherever it sits (`if (c) ({ path } = …)` was
 *     invisible while the braced form of that same branch failed) and read as a
 *     target rather than a property key, so a type literal the name appears in
 *     (`let opts: { path: string } = …`) is not one. A pattern nested inside
 *     another (`({ a: { path } } = …)`, `[[path]] = …`) is read by NEITHER
 *     spelling — the file header carries that as a bullet of its own, measured
 *     green — because a group holding a brace or a bracket of its own is not
 *     this pattern, which is the price of matching braces without nesting (see
 *     the code below).
 *
 * The ONE `=` that is not a second write is the declaration clause's, and it is
 * recognised by the text on the declaration's OWN line: `const path = …` is the
 * write `declaredInitializers` resolves through, `for (let path = …; …)` opens
 * with its keyword too, and a destructuring DECLARATION (`const { path } = …`,
 * `const [first, path] = …`) is a binding this scan registers nowhere — the hole
 * the file header already lists — rather than an assignment to the name this
 * guard is resolving. Everything else fires, and a parameter list is no
 * exception: a default is a write (`function f(path = …)` for the parameter,
 * `function f({ path } = {})` and `function f({ path = … })` for one inside a
 * pattern), so a request that could send a path the scan never read refuses
 * instead of resolving — the false-refusal direction this guard is allowed to
 * be wrong in, never an escape.
 *
 * What it does NOT read is in the file header's list of things this scan
 * cannot see: a NEW binding the scan registers nowhere — a destructuring
 * parameter (`function f({ path })`, whose slot stays `undefined` and so
 * matches nothing), a `catch (path)`, or a destructuring declaration that is
 * not the declaration `declaredInitializers` matches — and a value that reaches
 * the request from ANOTHER module, through an import or a write to an exported
 * binding. In the other direction it is by NAME in the file rather than by
 * scope, exactly as the resolution it guards is: an assignment to a same-named
 * local in an UNRELATED function fires it too, which is a refusal where a
 * resolution would have been right, never an escape.
 */
function reassignmentsOf(source: string, name: string): Reassignment[] {
	// Strings blanked as well, so a line inside a template is not read as an
	// assignment; the display text comes from `source`, which keeps the code.
	const code = blankStringBodies(source)
	const identifier = name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
	const found: number[] = []
	const record = (index: number): void => {
		if (!found.includes(index)) found.push(index)
	}
	// The ONE `=` this guard must not read is the declaration clause's, and it is
	// read off the declaration's OWN line: `const path = …` is the write the scan
	// resolves a name through, `for (let path = …; …)` opens with its keyword
	// too, and a destructuring DECLARATION is a binding this scan registers
	// nowhere rather than a write to the name being resolved.
	const declarationPrefix = /^\s*(?:for\s*\(\s*)?(?:export\s+)?(?:const|let|var)[ \t]+$/
	const declares = (index: number): boolean =>
		declarationPrefix.test(code.slice(code.lastIndexOf('\n', index - 1) + 1, index))
	// A DESTRUCTURING pattern that closes with `=` — `({ path } = …)`,
	// `[first, path] = …` — which writes the name without ever spelling
	// `name =`. Read wherever it sits, so the branch that never opened its own
	// statement is read like the branch that did. The name has to be a TARGET
	// rather than a property key, or a type literal it appears in
	// (`let opts: { path: string } = …`) would read as one. Nesting is not
	// read — a group that contains a brace or a bracket of its own is not this
	// pattern, in either spelling, wherever it is written — which is the one
	// hole this rule has always had, and the reason the braces are matched
	// without one: a `{` that opens a BODY would otherwise run to the first `}`
	// anywhere below it, which is the closing brace of the next pattern.
	const patternWrite = /(?<![\w$.])(?:\(?\{[^{}]*\}|\[[^\[\]]*\])[ \t]*=(?![=>])/g
	const target = new RegExp(`(?<![\\w$.])${identifier}(?![\\w$])(?![ \\t]*\\??[ \\t]*:)`)
	const patterns = [...code.matchAll(patternWrite)].map((match) => ({
		start: match.index,
		end: match.index + match[0].length,
		write: !declares(match.index) && target.test(match[0]),
	}))
	for (const pattern of patterns) {
		if (pattern.write) record(pattern.start)
	}
	const inPattern = (index: number): boolean =>
		patterns.some((pattern) => index >= pattern.start && index < pattern.end)
	// A plain assignment, WHATEVER carries it: `path = …` on a line of its own,
	// the one a branch writes on the line it opens (`if (c) path = …`), and the
	// one inside a block that opens with its guard. `(?![=>])` keeps `==`, `===`
	// and an arrow's `path =>` out; `(?<![\w$.])` keeps a property write out. A
	// name INSIDE one of the patterns above is that pattern's write, recorded
	// there.
	for (const match of code.matchAll(new RegExp(`(?<![\\w$.])${identifier}[ \\t]*=(?![=>])`, 'g'))) {
		if (!declares(match.index) && !inPattern(match.index)) record(match.index)
	}
	// The name is a local, so a write guarded by a property access
	// (`binding.path = …`) is not this one: `(?<![\w$.])`.
	for (const match of code.matchAll(
		new RegExp(`(?<![\\w$.])${identifier}[ \\t]*(?:[+\\-*/%&|^]|\\*\\*|<<|>>|>>>|&&|\\|\\||\\?\\?)=`, 'g'),
	)) {
		record(match.index)
	}
	// A loop binding: `for (path of …)` writes the name with no `=` at all.
	// `for (const path of …)` DECLARES one instead — a fresh binding in the
	// loop's own scope, which is the shadowing family this scan lists as a hole
	// rather than this write — so only the bare form is read here.
	for (const match of code.matchAll(
		new RegExp(`(?<![\\w$.])for[ \\t]*\\([ \\t]*${identifier}[ \\t]+(?:of|in)\\b`, 'g'),
	)) {
		record(match.index)
	}
	return found
		.sort((a, b) => a - b)
		.map((index) => ({
			line: lineOf(source, index),
			text: (source.slice(source.lastIndexOf('\n', index - 1) + 1, source.indexOf('\n', index)) ||
				source.slice(index))
				.trim()
				.replace(/\s+/g, ' '),
		}))
}

/**
 * The alternatives of a conditional path expression: a ternary's two value
 * branches, or both sides of a `??`. Every branch is a path this code can
 * take, so every branch has to resolve.
 */
function conditionalBranches(expression: string): string[] | undefined {
	let depth = 0
	let ternaries = 0
	let question = -1
	for (let i = 0; i < expression.length; i += 1) {
		const ch = expression[i] as string
		if (ch === "'" || ch === '"' || ch === '`') {
			i = skipString(expression, i) - 1
			continue
		}
		if (ch === '(' || ch === '[' || ch === '{') depth += 1
		else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
		else if (depth === 0) {
			if (ch === '?' && expression[i + 1] === '?' && expression[i + 2] !== '=') {
				return [expression.slice(0, i), expression.slice(i + 2)]
			}
			if (ch === '?' && expression[i + 1] !== '.' && expression[i + 1] !== '?') {
				if (ternaries === 0) question = i
				ternaries += 1
			} else if (ch === ':' && ternaries > 0) {
				ternaries -= 1
				if (ternaries === 0 && question >= 0) {
					return [expression.slice(question + 1, i), expression.slice(i + 1)]
				}
			}
		}
	}
	return undefined
}

interface ResolveContext {
	readonly source: string
	readonly file: string
	/** The body the request sits in, so an identifier can be checked against ITS parameters. */
	readonly body: FunctionBody
	readonly enclosing: string
	readonly where: string
	readonly failures: string[]
	/**
	 * The REQUEST_WRAPPERS entries a request this scan READ has actually driven
	 * — added as `triplesThroughWrapper` is entered, which is the only way a
	 * wrapper's call sites are ever resolved. Shared by reference through every
	 * context spread, and checked once per harvest: an entry nothing drives is
	 * a promise the map makes and the code never cashes, which is how a wrapper
	 * declared in a file this scan does not read resolves nothing in silence.
	 */
	readonly drivenWrappers: Set<string>
}

/** The RBAC verb an HTTP method maps to, or a failure for one that maps to none. */
function verbFor(method: string, kind: PathKind, context: ResolveContext): string | undefined {
	if (method === 'GET') return kind === 'collection' ? 'list' : 'get'
	if (method === 'POST') return 'create'
	if (method === 'PATCH') return 'patch'
	if (method === 'PUT') return 'update'
	if (method === 'DELETE') return kind === 'collection' ? 'deletecollection' : 'delete'
	context.failures.push(
		`${context.where}: \`${method}\` is not an HTTP method this scan knows, so it has no RBAC verb. Declare it in \`verbFor\` (and in KUBERNETES_CLAIMANT_RBAC_RULES if the claim path issues it).`,
	)
	return undefined
}

function triplesForBuilder(
	name: string,
	method: string,
	context: ResolveContext,
): ClaimPathTriple[] {
	const builder = PATH_BUILDERS[name]
	if (builder === undefined) {
		context.failures.push(
			`${context.where}: \`${name}(…)\` is not a path builder this scan knows. Declare it in PATH_BUILDERS with the apiGroup, the resource and the collection/object shape it addresses — the grant has to be backed by the resource a request actually reaches.`,
		)
		return []
	}
	const verb = verbFor(method, builder.kind, context)
	if (verb === undefined) return []
	return [{ apiGroup: builder.apiGroup, resource: builder.resource, verb }]
}

/**
 * Follow a wrapper — a function in these sources that takes its path as an
 * argument — through its own call sites: for `listPolicies`, every argument in
 * the declared parameter's position, in every scanned file. A wrapper no
 * scanned file declares, a wrapper with no call site here, or one whose
 * argument does not resolve, fails.
 *
 * The declaration is read through `functionBodies`, the SAME reader every
 * other half of this scan registers bodies with — so every shape a body is
 * registered from is a shape REQUEST_WRAPPERS' remedy works in:
 * `function NAME(…)`, `const NAME = … =>`, `= function …`. It used to be a
 * `function NAME(` regex of its own, and the two readers disagreed: a wrapper
 * declared `export const listSecretsV2 = async (client, path, signal) => { … }`
 * sat in NO declaration that lookup could find, so this returned the empty
 * list in silence, the call sites that hand it a path were never resolved, and
 * the request they issue was invisible to every case in this file — the map's
 * own prescribed remedy, disarming the scan. A wrapper the scan cannot find in
 * any scanned file FAILS here now, instead of resolving to nothing; the
 * related case — a wrapper declared in a file this scan does NOT read — is
 * caught from the map's side instead (`scanClaimPathSources`), which is where
 * an entry no scanned request drives is visible at all.
 */
function triplesThroughWrapper(
	wrapper: string,
	parameter: string,
	method: string,
	context: ResolveContext,
): ClaimPathTriple[] {
	// Entering here IS the follow: this is called only for a request whose path
	// is one of the wrapper's parameters, so it is the one place a wrapper's
	// call sites are read. Recorded, so an entry no request ever drives fails
	// the harvest instead of resolving nothing quietly.
	context.drivenWrappers.add(wrapper)
	const triples: ClaimPathTriple[] = []
	// Every scanned body that carries the wrapper's name, never the last one
	// seen: a call site's argument is read at ONE position, and two declarations
	// of the same name do not have to agree about which position that is, so
	// `parameterIndex` below is only meaningful for a single declaration.
	const declarations: { file: string; line: number; parameters: readonly (string | undefined)[] }[] =
		[]
	for (const file of CLAIM_PATH_SOURCES) {
		const source = blankComments(readFileSync(join(CLAIM_PATH_SOURCE_DIR, file), 'utf8'))
		for (const body of functionBodies(source)) {
			if (body.name !== wrapper) continue
			declarations.push({ file, line: lineOf(source, body.start), parameters: body.parameters })
		}
	}
	if (declarations.length === 0) {
		// No scanned file declares a body by this name, so there is no
		// declaration to reach the wrapper's call sites from — its own request
		// is the way in, and a name with no body behind it resolves nothing.
		// The same condition is reported from the map's side as well
		// (`scanClaimPathSources`), which is where it is visible for an entry
		// no scanned request drives; this is the request that named it.
		context.failures.push(
			`${context.where}: no file this scan reads declares \`${wrapper}\`, which REQUEST_WRAPPERS names as carrying its path in \`${parameter}\`. A wrapper's call sites are the half that resolves the path and they are reached from its DECLARATION, so a declaration this scan cannot find resolves nothing: declare it in one of the scanned files (${CLAIM_PATH_SOURCES.join(', ')}) in a shape this scan registers (\`function NAME(…)\`, or \`const NAME = … =>\`), or stop passing a path through it.`,
		)
		return triples
	}
	if (declarations.length > 1) {
		// Two bodies of the same name is a question this scan has no answer to:
		// the call sites are read at one parameter POSITION, and the two
		// declarations need not put the path parameter in the same slot. Reading
		// the LAST one's position — which is what this did — resolves every call
		// site through whichever declaration happens to be scanned last, so a
		// caller that puts its path in a slot its OWN signature does not use
		// resolves green. A real declaration does not have to be the last one to
		// be the one a call resolves through, so this fails rather than picks.
		context.failures.push(
			`${context.where}: \`${wrapper}\` is declared by more than one body this scan reads — ${declarations.map((entry) => `${entry.file}:${entry.line}`).join(' and ')}. A call site's argument is read at the declared parameter's POSITION and the two declarations need not agree on it, so which declaration a call resolves through is a guess this scan will not make: rename one of them, or split the entry in REQUEST_WRAPPERS so each name has the one declaration its call sites are resolved from.`,
		)
		return triples
	}
	const declaration = declarations[0] as {
		file: string
		line: number
		parameters: readonly (string | undefined)[]
	}
	// The declared parameter's POSITION, which is what a call site's argument is
	// read at — `indexOf` on the body's own positional parameter list, never a
	// name the scan looked up elsewhere.
	const parameterIndex = declaration.parameters.indexOf(parameter)
	if (parameterIndex === -1) {
		context.failures.push(
			`${declaration.file}:${declaration.line}: \`${wrapper}\` declares no parameter named \`${parameter}\`, which REQUEST_WRAPPERS says carries its path. A rename has to be declared here rather than resolved to the wrong argument.`,
		)
		return triples
	}

	const callsite = new RegExp(`(?<![\\w$.])${wrapper}\\s*\\(`, 'g')
	for (const file of CLAIM_PATH_SOURCES) {
		const source = blankComments(readFileSync(join(CLAIM_PATH_SOURCE_DIR, file), 'utf8'))
		for (const match of source.matchAll(callsite)) {
			const before = source.slice(Math.max(0, match.index - 12), match.index)
			if (/function\s+$/.test(before)) continue
			const open = match.index + match[0].length - 1
			const args = callArguments(source, open)
			const where = `${file}:${lineOf(source, open)}`
			if (args === undefined) {
				context.failures.push(
					`${where}: the argument list of \`${wrapper}(\` does not close — the scan cannot read the path it hands over.`,
				)
				continue
			}
			const argument = args[parameterIndex]
			if (argument === undefined) {
				context.failures.push(
					`${where}: \`${wrapper}(\` is called without its \`${parameter}\` argument, so the collection it lists is not knowable here.`,
				)
				continue
			}
			triples.push(...resolvePathExpression(argument, method, { ...context, where }))
		}
	}
	return triples
}

function resolveIdentifier(
	name: string,
	method: string,
	context: ResolveContext,
): ClaimPathTriple[] {
	const wrapperParameter = REQUEST_WRAPPERS[context.enclosing]
	// A body's OWN parameter comes first, and a body REQUEST_WRAPPERS does not
	// know is a failure rather than a name to look up elsewhere: the parameter
	// SHADOWS any declaration of the same name, so resolving it through one
	// would follow a path this code does not send. This is the half that makes
	// a second wrapper declare itself — `const probe = async (client, path,
	// signal) => { … client.request('GET', path, …) }` sitting under
	// `listPolicies` is attributed to `probe`, whose `path` is not a wrapper
	// the scan has call sites for, instead of resolving through `listPolicies`'
	// own call sites and passing green.
	const ownParameter = context.body.parameters.includes(name)
	if (ownParameter && wrapperParameter !== name) {
		context.failures.push(
			`${context.where}: \`${name}\` is a parameter of ${describeBody(context.body)}, which REQUEST_WRAPPERS does not declare as path-carrying. A parameter shadows every declaration of the same name in these sources, so the path is not knowable from here: if this IS a wrapper, declare \`${context.enclosing}\` in REQUEST_WRAPPERS with \`${name}\` as the parameter that carries its path — its call sites are then resolved too — and if it is not, pass a builder or a declared path instead of the parameter.`,
		)
		return []
	}
	// Before EITHER half is trusted: a name this source WRITES a second time — in
	// any of the four spellings `reassignmentsOf` reads, each read wherever it is
	// written rather than only where it opens a statement — resolves through
	// nothing, because which write it holds at this request is not a question a
	// declaration answers (see `reassignmentsOf`, and the plant it was measured
	// against). Both halves are covered by the same rule, and the second is the
	// one that reads a name off ANOTHER line: a wrapper's own path parameter is
	// resolved through its call sites, so a body that rewrites that parameter
	// before requesting resolves every caller's argument to a path the request
	// does not send — measured green, with the call site passing a real builder
	// and the body appending `/log` to it.
	const reassignments = reassignmentsOf(context.source, name)
	if (reassignments.length > 0) {
		context.failures.push(
			`${context.where}: \`${name}\` is ASSIGNED (${reassignments.map((entry) => `line ${entry.line}: ${entry.text}`).join(', ')}) somewhere other than the ONE write this scan reads for it — the \`const\`/\`let\`/\`var\` declaration it resolves a name through, or, for a wrapper's parameter, the call sites that hand it a path. The path this request sends is therefore not the one the pin resolves, and if the assignment appends to the resolved path that is a SUBRESOURCE (\`pods/log\`), which RBAC authorizes separately from its parent. Give the second path its own declaration (a second \`const\`, in the branch that needs it) or its own builder in PATH_BUILDERS, and pass a wrapper the path to send rather than rewriting its parameter — so that every path this file can send is one the scan reads.`,
		)
		return []
	}
	// The two places this name's path can be: a declaration in this file, and —
	// when the body is a wrapper REQUEST_WRAPPERS declares — the call sites that
	// hand the wrapper a path. A wrapper's own parameter holds no path to read
	// here, so only the second can resolve it; BOTH halves are read before this
	// returns, and neither resolving is a failure rather than an empty list —
	// a declared wrapper whose declaration or call sites this scan cannot
	// follow used to return nothing, unguarded, which is how the request that
	// named it escaped the pin.
	const triples = ownParameter
		? []
		: declaredInitializers(context.source, name).flatMap((initializer) =>
				resolvePathExpression(initializer, method, context),
			)
	if (wrapperParameter === name) {
		triples.push(...triplesThroughWrapper(context.enclosing, name, method, context))
	}
	if (triples.length === 0) {
		context.failures.push(
			ownParameter
				? `${context.where}: \`${name}\` is the parameter REQUEST_WRAPPERS declares carries \`${context.enclosing}\`'s path, and the wrapper's own call sites resolve no path this scan can follow — so this request reaches no resource the pin can name. Fix the wrapper's declaration or its call sites; the failure each one raises is reported above.`
				: `${context.where}: \`${name}\` resolves to no path this scan can follow — it is neither declared in \`${context.file}\` nor a REQUEST_WRAPPERS parameter of \`${context.enclosing}\`. Declare the path (or the wrapper) instead of letting the request escape the pin.`,
		)
	}
	return triples
}

/**
 * A path expression to the triples it can issue. The two escapes are closing
 * doors: an expression this function does not return triples for is reported
 * as a failure by the caller, never skipped.
 */
function resolvePathExpression(
	expression: string,
	method: string,
	context: ResolveContext,
): ClaimPathTriple[] {
	const trimmed = expression.trim()
	if (trimmed === '') {
		context.failures.push(`${context.where}: the path argument is empty.`)
		return []
	}
	const branches = conditionalBranches(trimmed)
	if (branches !== undefined) {
		return branches.flatMap((branch) => resolvePathExpression(branch, method, context))
	}
	const builder = /^([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed)
	if (builder !== null) {
		const name = builder[1] as string
		// The match is anchored at the START, so anything after the call is
		// unread unless it is walked — and what follows a builder call is the
		// escape this branch used to have: `podPath(ns, name) + '/log'` is the
		// `pods/log` SUBRESOURCE, which RBAC authorizes as its own resource, so
		// resolving it as `pods` called a 403 a match. Walk to the builder's own
		// `)` and require nothing but whitespace after it; a path with anything
		// appended is not traceable to a builder, whichever of the two spellings
		// it is written in (the template-literal form has always failed here).
		const open = builder[0].length - 1
		const closed = closeParen(trimmed, open)
		if (closed === undefined) {
			context.failures.push(
				`${context.where}: the arguments of \`${name}(\` never close, so the scan cannot tell where the builder call ends.`,
			)
			return []
		}
		const appended = trimmed.slice(closed + 1).trim()
		if (appended !== '') {
			context.failures.push(
				`${context.where}: \`${name}(…)\` has \`${appended.replace(/\s+/g, ' ').slice(0, 60)}\` appended to it. An appended path is a DIFFERENT resource than the builder addresses — a subresource (\`pods/log\`) is authorized separately from its parent — so a request built by concatenation is not traceable through the builder it starts with. Declare a builder for the WHOLE path in PATH_BUILDERS, the way every other path in these sources is built.`,
			)
			return []
		}
		return triplesForBuilder(name, method, context)
	}
	if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return resolveIdentifier(trimmed, method, context)
	context.failures.push(
		`${context.where}: the path expression \`${trimmed.replace(/\s+/g, ' ').slice(0, 80)}\` is not a declared path builder, a name holding one, or a conditional between two of them. A request whose path the scan cannot trace fails here rather than being skipped.`,
	)
	return []
}

interface Harvest {
	readonly observed: ObservedTriple[]
	readonly failures: string[]
}

/** Every request the pool-only path issues, resolved to its RBAC triple. */
function scanClaimPathSources(): Harvest {
	const observed: ObservedTriple[] = []
	const failures: string[] = []
	const drivenWrappers = new Set<string>()
	const declaredBodies = new Set<string>()
	for (const file of CLAIM_PATH_SOURCES) {
		const source = blankComments(readFileSync(join(CLAIM_PATH_SOURCE_DIR, file), 'utf8'))
		// Every body this source declares, by offset — so the request below is
		// attributed to the declaration whose braces contain it, never to the
		// nearest one written above it.
		const bodies = functionBodies(source)
		for (const body of bodies) {
			if (body.name !== undefined) declaredBodies.add(body.name)
		}
		for (const match of source.matchAll(/\[\s*['"`]request['"`]\s*\]/g)) {
			failures.push(
				`${file}:${lineOf(source, match.index)}: a computed \`['request']\` access is a route to the client this scan cannot follow. Call it as \`client.request(…) \`.`,
			)
		}
		for (const match of source.matchAll(/\.request\b/g)) {
			let i = match.index + '.request'.length
			if (source[i] === '<') {
				let depth = 0
				while (i < source.length) {
					const ch = source[i] as string
					if (ch === "'" || ch === '"' || ch === '`') {
						i = skipString(source, i)
						continue
					}
					if (ch === '<') depth += 1
					else if (ch === '>') {
						depth -= 1
						if (depth === 0) {
							i += 1
							break
						}
					}
					i += 1
				}
			}
			while (i < source.length && /\s/.test(source[i] as string)) i += 1
			const where = `${file}:${lineOf(source, match.index)}`
			if (source[i] !== '(') {
				const receiver = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(source.slice(0, match.index))?.[1]
				failures.push(
					`${where}: \`${receiver ?? ''}.request\` is referenced but not called — this scan follows literal \`.request('METHOD', …)\` calls only.`,
				)
				continue
			}
			const args = callArguments(source, i)
			if (args === undefined) {
				failures.push(`${where}: the argument list of \`request(\` does not close.`)
				continue
			}
			const method = quotedValue(args[0])
			if (method === undefined) {
				failures.push(
					`${where}: the method argument is not a quoted literal, so its RBAC verb is not knowable here.`,
				)
				continue
			}
			// Lexical, not textual: the innermost body whose braces CONTAIN the
			// call. A request outside every body fails here rather than being
			// read through a declaration it does not sit in.
			const body = enclosingBody(bodies, match.index)
			if (body === undefined) {
				failures.push(
					`${where}: this request is inside no function body this scan can match, so it cannot tell what its path argument is — and attributing it to a declaration it is not in would be worse than failing. Move it into a body this scan reads (a \`function\` declaration, or an arrow whose braces it can match), or declare the shape in this scan.`,
				)
				continue
			}
			const triples = resolvePathExpression(args[1] ?? '', method, {
				source,
				file,
				body,
				enclosing: body.label,
				where,
				failures,
				drivenWrappers,
			})
			for (const triple of triples) {
				observed.push({ triple, file, line: lineOf(source, match.index), enclosing: body.label })
			}
		}
	}
	// And the map itself is held to the code from this side: a REQUEST_WRAPPERS
	// entry is a promise that its call sites are resolved, and that promise has
	// two halves, neither of which reports anything by itself. The DECLARATION
	// has to be in a file this scan reads — a wrapper declared in one it does
	// not read is reached from nowhere, since the call sites are found through
	// its declaration — and it has to be DRIVEN by a request this scan reads,
	// which is the wrapper's own request passing the declared parameter on (a
	// body that never does resolves no caller's path at all). An entry failing
	// either half leaves every caller's path unresolved while every case above
	// stays green, which is the opposite of what declaring a wrapper is for.
	// Measured: a wrapper declared in the EXEMPT `k8s-client.ts` and called from
	// a scanned file was reached by nothing and failed neither, and an
	// arrow-declared wrapper of the same name resolved nothing in silence.
	for (const [wrapper, parameter] of Object.entries(REQUEST_WRAPPERS)) {
		if (!declaredBodies.has(wrapper)) {
			failures.push(
				`REQUEST_WRAPPERS declares \`${wrapper}\`, whose path parameter is \`${parameter}\`, and no file this scan reads declares a body of that name — so nothing reaches its call sites, and the paths they hand it stay unresolved. Declare it in one of ${CLAIM_PATH_SOURCES.join(', ')}, in a shape this scan registers (\`function NAME(…)\` or \`const NAME = … =>\`); a wrapper in a file this scan does not read cannot be followed from here, however its callers spell it.`,
			)
			continue
		}
		if (drivenWrappers.has(wrapper)) continue
		failures.push(
			`REQUEST_WRAPPERS declares \`${wrapper}\`, whose path parameter is \`${parameter}\`, and no request this scan reads resolves a path through it: the body that declares it never passes \`${parameter}\` to \`client.request(…)\`. Its call sites are resolved from that request and from nowhere else, so every path its callers hand over is unresolved — a wrapper that does not carry its path is not an indirection this scan can follow.`,
		)
	}
	return { observed, failures }
}

let harvested: Harvest | undefined
function harvest(): Harvest {
	harvested ??= scanClaimPathSources()
	return harvested
}

describe("the pool-only path's call sites", () => {
	it('resolves every request to a declared path builder, or fails', () => {
		const { failures } = harvest()
		expect(failures, failures.join('\n')).toEqual([])
	})

	it('observes no verb the constant does not grant, beyond the pool-LESS branch\u2019s own', () => {
		const { observed } = harvest()
		const granted = new Set(
			KUBERNETES_CLAIMANT_RBAC_RULES.flatMap((rule) =>
				rule.verbs.map((verb) =>
					tripleKey({ apiGroup: rule.apiGroup, resource: rule.resource, verb }),
				),
			),
		)
		const extras = observed.filter((entry) => !granted.has(tripleKey(entry.triple)))
		// Named one by one first, so the failure says which resource and where —
		// the author of a new call is told what to declare, not handed a set diff.
		for (const entry of extras) {
			expect(
				POOL_LESS_BRANCH_ONLY.some(
					(escape) =>
						tripleKey(escape.triple) === tripleKey(entry.triple) &&
						escape.file === entry.file &&
						escape.enclosing === entry.enclosing,
				),
				`${entry.file}:${entry.line} (in ${entry.enclosing}) issues ${describeTriple(entry.triple)}, which KUBERNETES_CLAIMANT_RBAC_RULES does not grant. Add it to the constant (and to k8s/manifests/rbac-claimant.yaml) if the CLAIM path issues it; if only the pool-LESS branch does, declare THAT call site in POOL_LESS_BRANCH_ONLY, where this Role's refusal of it is written down.`,
			).toBe(true)
		}
		// …and each declared call site exactly once, so a SECOND request issuing
		// an escaped verb is not excused by the entry that covers the first —
		// and a declaration nothing issues is caught from the other side.
		for (const escape of POOL_LESS_BRANCH_ONLY) {
			const sites = extras.filter(
				(entry) =>
					tripleKey(entry.triple) === tripleKey(escape.triple) &&
					entry.file === escape.file &&
					entry.enclosing === escape.enclosing,
			)
			expect(
				sites.map((entry) => `${entry.file}:${entry.line}`),
				`POOL_LESS_BRANCH_ONLY declares ${describeTriple(escape.triple)} at one call site (${escape.file}, in ${escape.enclosing}); the scan found ${sites.length}. A request this Role does not grant has to be declared: either add it to the constant and to k8s/manifests/rbac-claimant.yaml, or take it off the pool-only path.`,
			).toHaveLength(1)
		}
	})

	it('observes every verb the constant grants — a rule with no call site is a wider grant than the code needs', () => {
		const { observed } = harvest()
		const seen = new Set(observed.map((entry) => tripleKey(entry.triple)))
		const unobserved: ClaimPathTriple[] = []
		for (const rule of KUBERNETES_CLAIMANT_RBAC_RULES) {
			for (const verb of rule.verbs) {
				const triple = { apiGroup: rule.apiGroup, resource: rule.resource, verb }
				if (!seen.has(tripleKey(triple))) unobserved.push(triple)
			}
		}
		expect(
			unobserved.map(describeTriple),
			'a rule in KUBERNETES_CLAIMANT_RBAC_RULES has no call site in the pool-only path\u2019s sources. Either the call site went away — take the rule out, and take it out of k8s/manifests/rbac-claimant.yaml too — or it names a resource the path does not actually issue.',
		).toEqual([])
	})

	it("keeps the pool-LESS branch's own triples inside rbac.yaml, which a pool-less host holds", () => {
		// The escape from the constant is only defensible because those four
		// requests are exactly the ones the wider Role exists to grant: a host
		// that issues any of them is creating or reading its own Sandbox, and
		// `rbac-claimant.yaml`'s header sends that host to `rbac.yaml`.
		const widerRole = loadYaml('rbac.yaml').find(
			(doc) => (doc as Record<string, unknown>).kind === 'Role',
		) as Record<string, unknown>
		const wider = grantsByResource(widerRole)
		for (const { triple } of POOL_LESS_BRANCH_ONLY) {
			const ceiling = wider.get(triple.resource)
			expect(ceiling, `rbac.yaml grants nothing on ${triple.resource}`).toBeDefined()
			expect(
				ceiling?.verbs.has(triple.verb),
				`rbac.yaml does not grant ${triple.verb} on ${triple.resource}, so a pool-less host bound here would 403 on its own create path`,
			).toBe(true)
		}
	})
})

/**
 * How a file under the scanned directory reaches the client, or `undefined` if
 * it does not — the WHOLE predicate the case below asserts the file set
 * against, on comment-blanked text, in three halves:
 *
 *  1. `/\.request\b/`: the file calls the client itself, by the spelling the
 *     scan matches call sites with. Comment-blanked, so `// client.request(…)`
 *     in a doc comment is not a call site.
 *  2. the same call written as a COMPUTED access,
 *     `/\[\s*['"`]request['"`]\s*\]/` — `client['request']('GET', path)`
 *     contains no dot at all, and half one alone was a predicate whose own doc
 *     claimed the opposite: a file whose only route to the client is that
 *     spelling sat in neither `CLAIM_PATH_SOURCES` nor
 *     `CLAIM_PATH_SOURCE_EXEMPTIONS` while every case above stayed green, and
 *     declaring it scanned is what makes the scan's own refusal — "a computed
 *     `['request']` access is a route to the client this scan cannot follow" —
 *     apply to it. The route is caught here, and refused there.
 *  3. a reference by NAME to any wrapper `REQUEST_WRAPPERS` declares. A file
 *     that never spells `.request` but calls `listPolicies(client, path, …)`
 *     issues a request all the same, on the path it hands that wrapper — and
 *     before this half existed such a file sat in neither list while every
 *     case above stayed green, because the scan reads call sites in
 *     `CLAIM_PATH_SOURCES` only.
 *
 * What it is NOT, and no sentence above claims otherwise: a name match cannot
 * see a wrapper reached by ANOTHER name. A file that imports a re-export
 * (`listEveryPolicy` for `listPolicies`) or calls a helper that itself calls
 * the wrapper mentions none of the three, and this predicate counts it as not
 * reaching the client.
 */
function claimPathReach(source: string): string | undefined {
	if (/\.request\b/.test(source)) return 'calls `client.request(…)` itself'
	if (/\[\s*['"`]request['"`]\s*\]/.test(source)) {
		return "reaches the client through a computed `['request']` access, the spelling the scan refuses rather than follows"
	}
	for (const wrapper of Object.keys(REQUEST_WRAPPERS)) {
		if (new RegExp(`\\b${wrapper}\\b`).test(source)) {
			return `names \`${wrapper}\`, a wrapper REQUEST_WRAPPERS declares`
		}
	}
	return undefined
}

describe('the files this scan reads', () => {
	it('is the directory, not a four-name list: a file that reaches the client fails until it is declared', () => {
		// The escape this closes: `CLAIM_PATH_SOURCES` is a literal, and nothing
		// used to read the directory it names. `workspace.ts` — thirteen
		// `.request` mentions — was never opened, so a request planted in
		// it passed every case above, while the same triple planted in
		// `index.ts` failed by name. A file the scan does not read is a hole in
		// every claim it makes, and which files it reads has to be an assertion
		// about the directory rather than a list that can silently stop
		// covering it.
		const entries = readdirSync(CLAIM_PATH_SOURCE_DIR)
		const sources = entries.filter((entry) => entry.endsWith('.ts')).sort()
		expect(sources.length, 'no `.ts` source under the scanned directory').toBeGreaterThan(0)
		expect(
			entries.filter((entry) => !entry.endsWith('.ts')).sort(),
			'a non-source entry sits under the scanned directory. This scan does not recurse, so a `.ts` file inside it would never be read: declare the entry in CLAIM_PATH_DIR_NON_FILES with the reason it holds nothing on the pool-only path.',
		).toEqual(CLAIM_PATH_DIR_NON_FILES.map((entry) => entry.file).sort())

		const scanned = new Set<string>(CLAIM_PATH_SOURCES)
		const exempt = new Map(CLAIM_PATH_SOURCE_EXEMPTIONS.map((entry) => [entry.file, entry.reason]))
		// What "reaches the client" means here is `claimPathReach` above, in
		// full: the scan's own `.request` literal on the same blanked text, the
		// COMPUTED `['request']` spelling of the same call — `client['request']`
		// has no dot to match, and a file reaching the client that way is
		// exactly the file the scan's own `['request']` refusal has to be able
		// to name — OR a reference to a wrapper `REQUEST_WRAPPERS` declares,
		// which issues the request for the caller.
		const reaching = new Map<string, string>()
		for (const file of sources) {
			const reach = claimPathReach(blankComments(readFileSync(join(CLAIM_PATH_SOURCE_DIR, file), 'utf8')))
			if (reach !== undefined) reaching.set(file, reach)
		}
		for (const file of sources) {
			expect(
				!reaching.has(file) || scanned.has(file) || exempt.has(file),
				`${file} reaches the client — it ${reaching.get(file)} — and is in neither CLAIM_PATH_SOURCES nor CLAIM_PATH_SOURCE_EXEMPTIONS. A file that reaches the client is either part of the pool-only path — scan it — or declared off that path with the reason it cannot be on a claimant host's, so that leaving one out is a decision this file states rather than a name that was never added.`,
			).toBe(true)
		}

		// And the declarations hold in the other direction, so neither list can
		// decay: a name that is no file here, an exemption for a file that no
		// longer reaches the client, an exemption that is ALSO scanned (it
		// belongs in CLAIM_PATH_SOURCES — the exemption is for files off the
		// path, and scanning one would only weaken which triples it is held to),
		// and a reason that says nothing.
		for (const file of CLAIM_PATH_SOURCES) {
			expect(sources, `CLAIM_PATH_SOURCES names ${file}, which is not under the scanned directory`).toContain(
				file,
			)
		}
		for (const { file, reason } of [...CLAIM_PATH_SOURCE_EXEMPTIONS, ...CLAIM_PATH_DIR_NON_FILES]) {
			expect(reason.trim().length, `${file} is declared with no reason`).toBeGreaterThan(0)
		}
		for (const { file } of CLAIM_PATH_SOURCE_EXEMPTIONS) {
			expect(
				sources,
				`CLAIM_PATH_SOURCE_EXEMPTIONS names ${file}, which is not under the scanned directory`,
			).toContain(file)
			expect(
				reaching.has(file),
				`${file} is declared as an exemption but reaches the client no longer — neither \`client.request(…)\` nor a name REQUEST_WRAPPERS declares — so the declaration has outlived what it excused.`,
			).toBe(true)
			expect(
				scanned.has(file),
				`${file} is BOTH scanned and exempt. A file on the pool-only path belongs in CLAIM_PATH_SOURCES: scanned, it is held to the constant's triples, and that is the stronger place to be.`,
			).toBe(false)
		}
	})
})

describe('every path builder objects.ts declares', () => {
	it("is in the scan's own map, and nothing else is", () => {
		const source = readFileSync(join(CLAIM_PATH_SOURCE_DIR, 'objects.ts'), 'utf8')
		const exported = [...source.matchAll(/(?:^|\n)export function ([A-Za-z_$][\w$]*Path)\(/g)]
			.map((match) => match[1] as string)
			.sort()
		expect(exported.length, 'no `*Path` builder found — this scan would then prove nothing').toBeGreaterThan(0)
		expect(exported, 'a builder objects.ts declares is missing from PATH_BUILDERS, or vice versa').toEqual(
			Object.keys(PATH_BUILDERS).sort(),
		)
	})
})

describe('KUBERNETES_CLAIMANT_RBAC_RULES', () => {
	it('is frozen one level deeper than the outer array: every rule object, and its verbs', () => {
		expect(Object.isFrozen(KUBERNETES_CLAIMANT_RBAC_RULES)).toBe(true)
		for (const rule of KUBERNETES_CLAIMANT_RBAC_RULES) {
			expect(Object.isFrozen(rule), `${rule.resource}: rule object`).toBe(true)
			expect(Object.isFrozen(rule.verbs), `${rule.resource}: verbs`).toBe(true)
		}
	})

	it('refuses a write to a rule field, the shape a plain-JS consumer would attempt', () => {
		// A frozen ARRAY does not freeze its elements: without the freeze inside
		// the literal, `rule.resource = 'secrets'` silently rewrote the grant a
		// consumer compares its live Role against.
		const first = KUBERNETES_CLAIMANT_RBAC_RULES[0] as { resource: string } | undefined
		expect(first, 'the constant is empty').toBeDefined()
		expect(() => {
			;(first as { resource: string }).resource = 'secrets'
		}).toThrow(TypeError)
		expect(KUBERNETES_CLAIMANT_RBAC_RULES[0]?.resource).toBe('sandboxclaims')
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

describe('the default Role holds no write verb on any policy resource', () => {
	// The whole reason per-sandbox egress ships its write verbs in a file of
	// their own: a host that never configures `egress.perSandbox` must not be
	// able to create, change or delete a policy in its namespace, and a stanza
	// inside the default Role would grant it to everyone who applies that file.
	const docs = loadYaml('rbac.yaml') as Record<string, unknown>[]
	const role = docs.find((d) => d.kind === 'Role') as Record<string, unknown>

	it.each(['networkpolicies', 'ciliumnetworkpolicies'])('%s', (resource) => {
		const rules = role.rules as Record<string, unknown>[]
		const rule = rules.find((r) => (r.resources as string[]).includes(resource))
		expect(rule, `no rule grants ${resource}`).toBeDefined()
		for (const verb of ['create', 'patch', 'update', 'delete', 'deletecollection']) {
			expect(rule?.verbs as string[], `${resource} is writable by the default Role`).not.toContain(
				verb,
			)
		}
	})
})

describe('rbac-per-sandbox-egress.yaml', () => {
	const docs = loadYaml('rbac-per-sandbox-egress.yaml') as Record<string, unknown>[]
	const role = docs.find((d) => d.kind === 'Role') as Record<string, unknown>
	const clusterRole = docs.find((d) => d.kind === 'ClusterRole') as Record<string, unknown>
	const roleBinding = docs.find((d) => d.kind === 'RoleBinding') as Record<string, unknown>
	const clusterRoleBinding = docs.find((d) => d.kind === 'ClusterRoleBinding') as Record<
		string,
		unknown
	>
	const defaultDocs = loadYaml('rbac.yaml') as Record<string, unknown>[]
	const defaultRole = defaultDocs.find((d) => d.kind === 'Role') as Record<string, unknown>

	it('is a SEPARATE Role from the default one, so it can be left unapplied', () => {
		expect(role.kind).toBe('Role')
		expect((role.metadata as Record<string, unknown>).name).not.toBe(
			(defaultRole.metadata as Record<string, unknown>).name,
		)
		expect((role.metadata as Record<string, unknown>).namespace).toBe(
			(defaultRole.metadata as Record<string, unknown>).namespace,
		)
	})

	it('grants exactly the three write verbs the capability issues, and no read verbs', () => {
		const rules = role.rules as Record<string, unknown>[]
		expect(rules).toHaveLength(1)
		expect(rules[0]?.apiGroups).toEqual(['cilium.io'])
		expect(rules[0]?.resources).toEqual(['ciliumnetworkpolicies'])
		// `create` writes the first policy, `patch` replaces it, `delete` is
		// `setNetworkPolicy([])`. `get`/`list` are the default Role's and are
		// deliberately not repeated: two Roles granting the same verb would
		// drift the first time either check changed.
		expect(new Set(rules[0]?.verbs as string[])).toEqual(new Set(['create', 'patch', 'delete']))
	})

	it('reads the admission fence through a read-only ClusterRole, because it is cluster-scoped', () => {
		const rules = clusterRole.rules as Record<string, unknown>[]
		expect(rules).toHaveLength(1)
		expect(rules[0]?.apiGroups).toEqual(['admissionregistration.k8s.io'])
		expect(new Set(rules[0]?.resources as string[])).toEqual(
			new Set(['validatingadmissionpolicies', 'validatingadmissionpolicybindings']),
		)
		// READ only. A host that could write its own fence would not have one.
		expect(rules[0]?.verbs).toEqual(['get'])
	})

	it('binds both to the same ServiceAccount the default Role is bound to', () => {
		const defaultBinding = defaultDocs.find((d) => d.kind === 'RoleBinding') as Record<
			string,
			unknown
		>
		const account = (defaultBinding.subjects as Record<string, unknown>[])[0]
		for (const binding of [roleBinding, clusterRoleBinding]) {
			const subjects = binding.subjects as Record<string, unknown>[]
			expect(subjects).toHaveLength(1)
			expect(subjects[0]?.kind).toBe('ServiceAccount')
			expect(subjects[0]?.name).toBe(account?.name)
			expect(subjects[0]?.namespace).toBe(account?.namespace)
		}
	})

	it('grants no wildcard apiGroup, resource or verb', () => {
		for (const subject of [role, clusterRole]) {
			for (const rule of subject.rules as Record<string, unknown>[]) {
				for (const field of ['apiGroups', 'resources', 'verbs'] as const) {
					expect(rule[field] as string[]).not.toContain('*')
				}
			}
		}
	})
})

describe('validatingadmissionpolicy-cilium.yaml', () => {
	const docs = loadYaml('validatingadmissionpolicy-cilium.yaml') as Record<string, unknown>[]
	const policy = docs.find((d) => d.kind === 'ValidatingAdmissionPolicy') as Record<string, unknown>
	const binding = docs.find((d) => d.kind === 'ValidatingAdmissionPolicyBinding') as Record<
		string,
		unknown
	>
	const spec = policy.spec as Record<string, unknown>
	const validations = spec.validations as Record<string, unknown>[]
	const expressions = validations.map((v) => v.expression as string).join('\n')

	it('fails closed', () => {
		// An expression that errors — an unexpected type, a shape nothing here
		// anticipated — must refuse the write rather than admit it.
		expect(spec.failurePolicy).toBe('Fail')
	})

	it('covers DELETE as well as CREATE and UPDATE', () => {
		// Without DELETE the host could remove the operator's own baseline
		// policy with the `delete` verb the opt-in Role grants it.
		const rules = (spec.matchConstraints as { resourceRules: Record<string, unknown>[] })
			.resourceRules
		expect(rules).toHaveLength(1)
		expect(rules[0]?.apiGroups).toEqual(['cilium.io'])
		expect(rules[0]?.resources).toEqual(['ciliumnetworkpolicies'])
		expect(new Set(rules[0]?.operations as string[])).toEqual(
			new Set(['CREATE', 'UPDATE', 'DELETE']),
		)
	})

	it('bounds ONE identity, so an operator applying the baseline is unaffected', () => {
		const conditions = spec.matchConditions as Record<string, unknown>[]
		expect(conditions).toHaveLength(1)
		expect(conditions[0]?.expression as string).toContain('request.userInfo.username')
		expect(conditions[0]?.expression as string).toContain('system:serviceaccount:')
	})

	it('pins the same name prefix the backend writes under', () => {
		// Driven from the exported constant, never a hand-written copy: the
		// prefix is half of a contract with an object an operator applies, so a
		// rename has to fail here rather than silently produce a fence that
		// admits nothing.
		expect(expressions).toContain(`'${PER_SANDBOX_POLICY_NAME_PREFIX}'`)
	})

	it('refuses every peer kind that is not a name or the cluster resolver', () => {
		for (const field of [
			'toCIDR',
			'toCIDRSet',
			'toEntities',
			'toServices',
			'toGroups',
			'toNodes',
			'toRequires',
		]) {
			expect(expressions, `${field} is not refused`).toContain(`has(r.${field})`)
		}
		// `specs` is the CRD's list-of-specs alternative to `spec`; a fence
		// that read only `spec` would be walked straight past by it.
		expect(expressions).toContain('specs')
		expect(expressions).toContain('ingress')
	})

	it('bounds the selector to the object that owns the policy, not merely to one label', () => {
		// One matchLabels entry is a SHAPE, not a bound: `sandbox.namzu.ai/
		// template: namzu-task` is one label and selects every sandbox pod in
		// the namespace. The bound is the KEY and the VALUE together — the
		// per-sandbox label key holding the owner's own name, which is what
		// the backend puts on the pod and selects on.
		expect(expressions).toContain('variables.owners[0].name')
		expect(expressions).toContain('variables.selector.matchLabels.all(')
	})

	it('pins the selector KEY to the one the backend writes, from the exported default', () => {
		// The VALUE check alone leaves a hole: a host chooses the names of the
		// objects it creates, so a claim named `namzu-task` would satisfy
		// "value equals the owner's name" while selecting on
		// `sandbox.namzu.ai/template` — every sandbox pod in the namespace.
		// Driven from the constant, so a rename has to fail here.
		expect(expressions).toContain(`k == '${DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY}'`)
	})

	it('gates every rule but the name on writes, so DELETE is bounded by the prefix alone', () => {
		// Said out loud because the manifest's own prose used to overstate it:
		// a validating policy cannot tell which sandboxes a host holds, so the
		// DELETE arm protects every policy OUTSIDE the namzu-sbx- prefix — the
		// operator's baseline — and not one namzu-sbx- policy from another.
		const nameRule = validations[0]?.expression as string
		expect(nameRule).toContain(`startsWith('${PER_SANDBOX_POLICY_NAME_PREFIX}')`)
		expect(nameRule).not.toContain('variables.writing')
		for (const validation of validations.slice(1)) {
			expect(validation.expression as string).toContain('!variables.writing ||')
		}
	})

	it('refuses a toFQDNs entry that matches every name', () => {
		// `toFQDNs: [{matchPattern: '*'}]` is a toFQDNs rule to the letter and
		// unrestricted egress in fact, so the ENTRIES are checked, not just the
		// peer kind.
		expect(expressions).toContain('f.matchPattern.matches(')
		expect(expressions).toContain('f.matchName.matches(')
		const entryRule = validations
			.map((v) => v.expression as string)
			.find((e) => e.includes('f.matchPattern.matches('))
		expect(entryRule).toBeDefined()
		const patterns = [...(entryRule ?? '').matchAll(/matches\('([^']+)'\)/g)].map((m) => m[1] ?? '')
		expect(patterns).toHaveLength(2)
		const [nameRe, patternRe] = patterns as [string, string]
		// The two regular expressions the API server will compile, exercised
		// here against the shapes that matter — RE2 and JavaScript agree on
		// this subset (character classes, anchors, `*`, `?`, `+`).
		for (const admitted of ['registry.npmjs.org', 'internal', 'a-b.example.com']) {
			expect(new RegExp(nameRe).test(admitted), `${admitted} refused`).toBe(true)
		}
		for (const refused of ['*', '*.example.com', 'a..b', '-lead.example.com', '']) {
			expect(new RegExp(nameRe).test(refused), `${refused} admitted`).toBe(false)
		}
		for (const admitted of ['*.example.com', '*.a.b.example.com']) {
			expect(new RegExp(patternRe).test(admitted), `${admitted} refused`).toBe(true)
		}
		for (const refused of ['*', '*.*', '*.com', '*.a*.com', 'example.com', '**.example.com']) {
			expect(new RegExp(patternRe).test(refused), `${refused} admitted`).toBe(false)
		}
	})

	it('bounds the kube-dns rule to port 53', () => {
		// Otherwise a rule wearing the DNS rule's toEndpoints could carry any
		// port and be ordinary egress to those pods.
		expect(expressions).toContain("q.port == '53'")
	})

	it('names the ServiceAccount and namespace rbac.yaml actually ships', () => {
		// The fence matches ONE username and ONE namespace, both spelled out
		// as literals here while rbac.yaml owns the objects. A rename in one
		// file alone leaves a fence that matches nothing — inert, and still
		// passing the backend's existence GET, which is exactly the failure
		// the binding check exists to avoid.
		const rbac = loadYaml('rbac.yaml') as Record<string, unknown>[]
		const account = rbac.find((d) => d.kind === 'ServiceAccount') as Record<string, unknown>
		const meta = account.metadata as { name: string; namespace: string }
		const conditions = spec.matchConditions as Record<string, unknown>[]
		expect((conditions[0]?.expression as string).replace(/\s+/g, ' ')).toContain(
			`'system:serviceaccount:${meta.namespace}:${meta.name}'`,
		)
		const selector = (binding.spec as { matchResources: { namespaceSelector: unknown } })
			.matchResources.namespaceSelector as { matchLabels: Record<string, string> }
		expect(selector.matchLabels['kubernetes.io/metadata.name']).toBe(meta.namespace)
	})

	it('binds the policy, and denies rather than warns', () => {
		const bindingSpec = binding.spec as Record<string, unknown>
		expect(bindingSpec.policyName).toBe((policy.metadata as Record<string, unknown>).name)
		// A ValidatingAdmissionPolicy with no binding validates nothing at all,
		// and one bound with `Warn` would leave the host's write access
		// unbounded while looking fenced.
		expect(bindingSpec.validationActions).toEqual(['Deny'])
	})
})
