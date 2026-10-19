/**
 * Per-sandbox egress on the workspace entry point (#618).
 *
 * A stateful fake cluster: a Sandbox store a POST fills and a DELETE empties,
 * a CiliumNetworkPolicy store, the SHIPPED admission fence, and an owner
 * garbage collector that removes every policy naming a deleted object's uid in
 * its `ownerReferences` — the one thing of a real cluster's GC this suite
 * relies on, and the reason "deleting the workspace garbage-collects the
 * policy" is asserted as "the policy names the Sandbox's uid and nothing but
 * the cluster removes it": this backend issues no policy DELETE on a delete.
 *
 * Nothing here is ENFORCEMENT. Whether a pod can reach a host is a statement
 * about a CNI's data plane, and it needs a Cilium cluster.
 *
 * No test here races real time: every wait is on a promise the code under
 * test returns.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KUBERNETES_PER_SANDBOX_PROFILE_VARIANT,
	allocateKubernetesWorkspace,
	createKubernetesWorkspace,
	resolveKubernetesExecutionProfile,
} from '../../../index.js'
import { DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY, translateEgressPolicy } from '../egress-policy.js'
import { KubernetesWorkspaceReplacedError } from '../identity.js'
import {
	KubernetesAdmissionFenceMissingError,
	KubernetesOwnerUidMissingError,
} from '../per-sandbox-policy.js'
import { KubernetesWorkspaceMismatchError } from '../workspace.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { type FenceObjects, shippedFence } from './fixtures/fence-objects.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const TEMPLATE = 'namzu-workspace'
const WORKSPACE_ID = 'long-lived'
const WORKSPACE_NAME = 'namzu-ws-long-lived'
const ADMISSION_POLICY = 'namzu-per-sandbox-egress'
const LABEL_KEY = DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY
const TEMPLATE_LABEL = { 'sandbox.namzu.ai/template': TEMPLATE } as const
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SECOND_SANDBOX_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const REGISTRY = 'registry.example.org'

const WORKSPACE_TEMPLATE = {
	metadata: { name: TEMPLATE, namespace: NAMESPACE },
	spec: {
		service: true,
		volumeClaimTemplates: [
			{
				metadata: { name: 'workspace' },
				spec: { accessModes: ['ReadWriteOnce'], volumeMode: 'Block' },
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

interface StoredSandbox {
	uid: string
	mode: 'Running' | 'Suspended'
	/** Whether the pod has been replaced since the first resume. */
	resumed: boolean
	body: Record<string, unknown>
}

interface Cluster {
	server: FakeApiServer
	sandboxes: Map<string, StoredSandbox>
	policies: Map<string, Record<string, unknown>>
	others: Record<string, unknown>[]
	fence: FenceObjects
	fenceMode: { current: 'both' | 'no-binding' }
	/** The uid the next POST /sandboxes assigns. */
	nextUid: { current: string; omit: boolean }
}

let cluster: Cluster | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
let baseline: Record<string, unknown>

beforeEach(async () => {
	agent = await startScriptedAgent({ host: '0.0.0.0', token: FIRST_POD_UID })
	restoreDns = stubLoopbackDns()
	baseline = (
		await translateEgressPolicy({ kind: 'no-network' }, 'core', {
			namespace: NAMESPACE,
			name: `${TEMPLATE}-egress`,
			sandboxTemplateName: TEMPLATE,
		})
	).manifest
	cluster = await startCluster()
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await cluster?.server.close()
	await agent?.close()
	cluster = undefined
	agent = undefined
})

function podLabelsOf(stored: StoredSandbox): Record<string, string> {
	const spec = stored.body.spec as {
		podTemplate?: { metadata?: { labels?: Record<string, string> } }
	}
	return { ...spec.podTemplate?.metadata?.labels }
}

function livePod(stored: StoredSandbox, uid: string, terminating = false): Record<string, unknown> {
	return {
		metadata: {
			name: WORKSPACE_NAME,
			uid,
			labels: podLabelsOf(stored),
			...(terminating ? { deletionTimestamp: '2026-10-19T00:00:01Z' } : {}),
		},
		status: { phase: 'Running' },
	}
}

async function startCluster(): Promise<Cluster> {
	const sandboxes = new Map<string, StoredSandbox>()
	const policies = new Map<string, Record<string, unknown>>()
	const others: Record<string, unknown>[] = []
	const fence = shippedFence()
	const fenceMode = { current: 'both' as 'both' | 'no-binding' }
	const nextUid = { current: SANDBOX_UID, omit: false }
	const handler = (req: RecordedRequest): FakeApiReply => {
		if (req.path.includes('/validatingadmissionpolicybindings/')) {
			return fenceMode.current === 'no-binding'
				? { status: 404, body: {} }
				: { status: 200, body: fence.binding }
		}
		if (req.path.includes('/validatingadmissionpolicies/')) {
			return { status: 200, body: fence.policy }
		}
		if (req.path.includes('/ciliumnetworkpolicies')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1)
			if (req.method === 'GET' && name === 'ciliumnetworkpolicies') {
				return { status: 200, body: { items: [...policies.values(), ...others] } }
			}
			if (req.method === 'POST') {
				const body = req.body as { metadata: { name: string } }
				if (policies.has(body.metadata.name)) return { status: 409, body: {} }
				policies.set(body.metadata.name, body as unknown as Record<string, unknown>)
				return { status: 201, body }
			}
			if (req.method === 'PATCH') {
				const current = policies.get(name)
				if (current === undefined) return { status: 404, body: {} }
				policies.set(name, { ...current, ...(req.body as Record<string, unknown>) })
				return { status: 200, body: policies.get(name) }
			}
			if (req.method === 'DELETE') {
				return policies.delete(name) ? { status: 200, body: {} } : { status: 404, body: {} }
			}
			const stored = policies.get(name)
			return stored === undefined ? { status: 404, body: {} } : { status: 200, body: stored }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: WORKSPACE_TEMPLATE }
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			return { status: 200, body: baseline }
		}
		if (req.method === 'GET' && req.path.endsWith('/networkpolicies')) {
			return { status: 200, body: { items: [baseline] } }
		}
		if (req.path.endsWith('/sandboxes') && req.method === 'POST') {
			const body = req.body as { metadata: { name: string } }
			if (sandboxes.has(body.metadata.name)) return { status: 409, body: {} }
			const uid = nextUid.current
			sandboxes.set(body.metadata.name, {
				uid,
				mode: 'Running',
				resumed: false,
				body: body as unknown as Record<string, unknown>,
			})
			return {
				status: 201,
				body: nextUid.omit
					? { metadata: { name: body.metadata.name } }
					: { metadata: { name: body.metadata.name, uid } },
			}
		}
		if (req.path.includes('/sandboxes/')) {
			const name = req.path.slice(req.path.lastIndexOf('/') + 1).split('?')[0] ?? ''
			const stored = sandboxes.get(name)
			if (stored === undefined) return { status: 404, body: { message: 'gone' } }
			if (req.method === 'PATCH') {
				// A merge patch from an unfenced transition, or the JSON patch a
				// transition sends once the object's uid is known (its `test` ops
				// are not evaluated here: a replaced Sandbox is a different test).
				const body = req.body as unknown
				const mode = Array.isArray(body)
					? (
							body.find((op: { path?: string }) => op.path === '/spec/operatingMode') as
								| { value?: 'Running' | 'Suspended' }
								| undefined
						)?.value
					: (body as { spec?: { operatingMode?: 'Running' | 'Suspended' } }).spec?.operatingMode
				if (mode === 'Running' && stored.mode === 'Suspended') stored.resumed = true
				if (mode !== undefined) stored.mode = mode
				return { status: 200, body: {} }
			}
			if (req.method === 'DELETE') {
				sandboxes.delete(name)
				// The cluster's owner garbage collector, and nothing else.
				for (const [policyName, policy] of [...policies]) {
					const owners =
						(policy.metadata as { ownerReferences?: { uid?: string }[] }).ownerReferences ?? []
					if (owners.some((owner) => owner.uid === stored.uid)) policies.delete(policyName)
				}
				return { status: 200, body: {} }
			}
			const suspended = stored.mode === 'Suspended'
			const spec = stored.body.spec as Record<string, unknown>
			return {
				status: 200,
				body: {
					metadata: {
						...(stored.body.metadata as Record<string, unknown>),
						uid: stored.uid,
					},
					spec: { ...spec, operatingMode: stored.mode },
					status: {
						conditions: [readyCondition(suspended ? 'False' : 'True')],
						podIPs: ['10.244.0.6'],
						serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local`,
						selector: 'agents.x-k8s.io/sandbox-name-hash=llv',
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods?')) {
			const stored = sandboxes.get(WORKSPACE_NAME)
			if (stored === undefined || stored.mode === 'Suspended') {
				return { status: 200, body: { items: [] } }
			}
			return {
				status: 200,
				body: {
					items: stored.resumed
						? [livePod(stored, FIRST_POD_UID, true), livePod(stored, SECOND_POD_UID)]
						: [livePod(stored, FIRST_POD_UID)],
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			const stored = sandboxes.get(WORKSPACE_NAME)
			if (stored === undefined || stored.mode === 'Suspended') {
				return { status: 404, body: { message: 'gone' } }
			}
			return {
				status: 200,
				body: stored.resumed
					? livePod(stored, FIRST_POD_UID, true)
					: livePod(stored, FIRST_POD_UID),
			}
		}
		return { status: 404, body: { message: 'unexpected' } }
	}
	const server = await startFakeApiServer(handler)
	return { server, sandboxes, policies, others, fence, fenceMode, nextUid }
}

function publicConfig(perSandbox: boolean, egressExtra: Record<string, unknown> = {}) {
	if (!cluster || !agent) throw new Error('fixtures not started')
	return {
		tier: 'microvm' as const,
		service: 'kubernetes' as const,
		access: { server: cluster.server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TEMPLATE,
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		egress: {
			policy: { kind: 'no-network' as const },
			...(perSandbox
				? {
						perSandbox: {
							engine: 'cilium' as const,
							admissionPolicyName: ADMISSION_POLICY,
						},
					}
				: {}),
			...egressExtra,
		},
	}
}

async function open(perSandbox = true) {
	return await createKubernetesWorkspace(publicConfig(perSandbox), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: '/workspace',
	})
}

function policyWrites(): readonly RecordedRequest[] {
	return (cluster?.server.requests ?? []).filter(
		(r) => r.path.includes('/ciliumnetworkpolicies') && r.method !== 'GET',
	)
}

function sandboxPost(): { metadata: Record<string, unknown>; spec: Record<string, any> } {
	const posted = cluster?.server.matching('POST', '/sandboxes') ?? []
	expect(posted).toHaveLength(1)
	return posted[0]?.body as { metadata: Record<string, unknown>; spec: Record<string, any> }
}

describe('a workspace created with perSandbox', () => {
	it('stamps the per-sandbox label on the directly created Sandbox pod template', async () => {
		const workspace = await open()

		const labels = sandboxPost().spec.podTemplate.metadata.labels
		expect(labels).toEqual({ ...TEMPLATE_LABEL, [LABEL_KEY]: WORKSPACE_NAME })
		expect(typeof workspace.setNetworkPolicy).toBe('function')
		await workspace.destroy()
	})

	it('proves the admission fence BEFORE the create POST', async () => {
		await open()
		const requests = cluster?.server.requests ?? []
		const fenceAt = requests.findIndex((r) => r.path.includes('/validatingadmissionpolicies/'))
		const postAt = requests.findIndex((r) => r.method === 'POST' && r.path.endsWith('/sandboxes'))
		expect(fenceAt).toBeGreaterThanOrEqual(0)
		expect(fenceAt).toBeLessThan(postAt)
	})

	it('refuses to create when the fence is not there, having POSTed nothing', async () => {
		if (!cluster) throw new Error('fixtures not started')
		cluster.fenceMode.current = 'no-binding'

		const failure = await open().catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		expect(cluster.server.matching('POST', '/sandboxes')).toHaveLength(0)
	})

	it('writes, reads back and union-checks exactly as a task handle does', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		const before = cluster.server.requests.length

		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })

		const policyName = `namzu-sbx-${SANDBOX_UID}`
		const written = cluster.policies.get(policyName) as {
			metadata: { ownerReferences: Record<string, unknown>[] }
			spec: { endpointSelector: { matchLabels: Record<string, string> } }
		}
		// Owned by the Sandbox, selected by the per-sandbox label whose value is
		// the Sandbox's own name.
		expect(written.metadata.ownerReferences).toEqual([
			{
				apiVersion: expect.stringContaining('agents.x-k8s.io/'),
				kind: 'Sandbox',
				name: WORKSPACE_NAME,
				uid: SANDBOX_UID,
			},
		])
		expect(written.spec.endpointSelector.matchLabels).toEqual({ [LABEL_KEY]: WORKSPACE_NAME })
		const log = cluster.server.requests.slice(before).map((r) => `${r.method} ${r.path}`)
		const collection = `/namespaces/${NAMESPACE}/ciliumnetworkpolicies`
		const postAt = log.findIndex((l) => l === `POST ${'/apis/cilium.io/v2'}${collection}`)
		const readBackAt = log.findIndex(
			(l) => l === `GET /apis/cilium.io/v2${collection}/${policyName}`,
		)
		const unionAt = log.findIndex((l) => l === `GET /apis/cilium.io/v2${collection}`)
		expect(postAt).toBeGreaterThanOrEqual(0)
		expect(readBackAt).toBeGreaterThan(postAt)
		expect(unionAt).toBeGreaterThan(readBackAt)
		await workspace.destroy()
	})

	it('deletes its own object and throws when a policy applied since allows more', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		cluster.others.push({
			metadata: { name: 'someone-elses', namespace: NAMESPACE },
			spec: {
				endpointSelector: { matchLabels: TEMPLATE_LABEL },
				egress: [{ toEntities: ['world'] }],
			},
		})

		const failure = await workspace
			.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
			.catch((err: unknown) => err)

		expect((failure as Error).name).toBe('KubernetesEgressPolicyUnionError')
		expect(cluster.policies.size).toBe(0)
		await workspace.destroy()
	})

	it('removes a policy with an empty list, as on a task handle', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		expect(cluster.policies.size).toBe(1)

		await workspace.setNetworkPolicy?.({ allowedHosts: [] })

		expect(cluster.policies.size).toBe(0)
		await workspace.destroy()
	})

	it('leaves deletion to the cluster: the policy names the Sandbox, and no policy DELETE is sent', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		expect(cluster.policies.size).toBe(1)

		await workspace.destroy({ deleteDisk: true })

		expect(cluster.sandboxes.size).toBe(0)
		// Gone because the fake's GC followed the owner reference...
		expect(cluster.policies.size).toBe(0)
		// ...and not because this backend asked.
		expect(policyWrites().filter((w) => w.method === 'DELETE')).toHaveLength(0)
	})

	it('refuses to write for a Sandbox that was deleted and created again under the name', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		const stored = cluster.sandboxes.get(WORKSPACE_NAME)
		if (stored === undefined) throw new Error('no sandbox')
		stored.uid = SECOND_SANDBOX_UID
		const writesBefore = policyWrites().length

		const failure = await workspace
			.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect(policyWrites()).toHaveLength(writesBefore)
	})

	it('refuses setNetworkPolicy when the create reply and the object carry no uid, writing nothing', async () => {
		if (!cluster) throw new Error('fixtures not started')
		cluster.nextUid.omit = true
		cluster.nextUid.current = ''
		const workspace = await open()

		const failure = await workspace
			.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
			.catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesOwnerUidMissingError)
		expect(policyWrites()).toHaveLength(0)
	})
})

describe('suspend and resume, deterministically', () => {
	it('keeps the policy the Sandbox owns, and sends no policy write on the way', async () => {
		if (!cluster || !agent) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		const kept = cluster.policies.get(`namzu-sbx-${SANDBOX_UID}`)
		const writesBefore = policyWrites().length

		await workspace.suspend()
		agent.setToken(SECOND_POD_UID)
		await workspace.resume()

		expect(cluster.policies.get(`namzu-sbx-${SANDBOX_UID}`)).toBe(kept)
		expect(policyWrites()).toHaveLength(writesBefore)
		await workspace.destroy()
	})

	it('re-proves the fence from scratch on every resume, before the patch', async () => {
		if (!cluster || !agent) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		await workspace.suspend()
		const fenceReads = cluster.server.matching('GET', '/validatingadmissionpolicybindings/').length
		const patchesBefore = cluster.server.matching('PATCH', '/sandboxes/').length
		agent.setToken(SECOND_POD_UID)

		await workspace.resume()

		expect(
			cluster.server.matching('GET', '/validatingadmissionpolicybindings/').length,
		).toBeGreaterThan(fenceReads)
		const requests = cluster.server.requests
		let lastFence = -1
		let resumePatch = -1
		requests.forEach((r, i) => {
			if (r.path.includes('/validatingadmissionpolicybindings/')) lastFence = i
			if (r.method === 'PATCH' && r.path.includes('/sandboxes/')) resumePatch = i
		})
		expect(lastFence).toBeLessThan(resumePatch)
		expect(cluster.server.matching('PATCH', '/sandboxes/').length).toBe(patchesBefore + 1)
		await workspace.destroy()
	})

	it('refuses a resume whose fence no longer verifies, leaving the workspace suspended and nothing patched', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.suspend()
		cluster.fenceMode.current = 'no-binding'
		const patchesBefore = cluster.server.matching('PATCH', '/sandboxes/').length

		const failure = await workspace.resume().catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
		expect(cluster.server.matching('PATCH', '/sandboxes/')).toHaveLength(patchesBefore)
		expect(cluster.sandboxes.get(WORKSPACE_NAME)?.mode).toBe('Suspended')
		expect(workspace.suspended).toBe(true)
	})

	it('drops a policy this Sandbox does not own on resume, and keeps every other', async () => {
		if (!cluster || !agent) throw new Error('fixtures not started')
		const workspace = await open()
		await workspace.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		await workspace.suspend()
		// Left by a workspace of this name that was deleted and has not been
		// collected yet: it selects this workspace's label value, owned by a
		// uid that is gone.
		const stale = `namzu-sbx-${SECOND_SANDBOX_UID}`
		cluster.policies.set(stale, {
			metadata: {
				name: stale,
				ownerReferences: [{ kind: 'Sandbox', name: WORKSPACE_NAME, uid: SECOND_SANDBOX_UID }],
			},
			spec: { endpointSelector: { matchLabels: { [LABEL_KEY]: WORKSPACE_NAME } } },
		})
		// Another workspace's own grant: a different label value.
		const neighbour = 'namzu-sbx-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
		cluster.policies.set(neighbour, {
			metadata: {
				name: neighbour,
				ownerReferences: [{ kind: 'Sandbox', name: 'namzu-ws-other', uid: 'cccccccc' }],
			},
			spec: { endpointSelector: { matchLabels: { [LABEL_KEY]: 'namzu-ws-other' } } },
		})
		agent.setToken(SECOND_POD_UID)

		await workspace.resume()

		expect([...cluster.policies.keys()].sort()).toEqual(
			[`namzu-sbx-${SANDBOX_UID}`, neighbour].sort(),
		)
		expect(
			policyWrites()
				.filter((w) => w.method === 'DELETE')
				.map((w) => w.path),
		).toEqual([expect.stringContaining(stale)])
		await workspace.destroy()
	})

	it('applies the same rule when an existing workspace is opened again', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const first = await open()
		await first.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		const stale = `namzu-sbx-${SECOND_SANDBOX_UID}`
		cluster.policies.set(stale, {
			metadata: {
				name: stale,
				ownerReferences: [{ kind: 'Sandbox', name: WORKSPACE_NAME, uid: SECOND_SANDBOX_UID }],
			},
			spec: { endpointSelector: { matchLabels: { [LABEL_KEY]: WORKSPACE_NAME } } },
		})

		const second = await open()

		expect(second.origin).toBe('adopted-running')
		expect([...cluster.policies.keys()]).toEqual([`namzu-sbx-${SANDBOX_UID}`])
		await second.destroy()
	})

	it('drops a leftover policy right after it creates a workspace under a reused name', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const stale = `namzu-sbx-${SECOND_SANDBOX_UID}`
		cluster.policies.set(stale, {
			metadata: {
				name: stale,
				ownerReferences: [{ kind: 'Sandbox', name: WORKSPACE_NAME, uid: SECOND_SANDBOX_UID }],
			},
			spec: { endpointSelector: { matchLabels: { [LABEL_KEY]: WORKSPACE_NAME } } },
		})

		const workspace = await open()

		expect(cluster.policies.size).toBe(0)
		await workspace.destroy()
	})

	it('reopens a workspace that holds a grant under a Cilium baseline, whose union check would read the grant as a widening', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const translated = await translateEgressPolicy(
			{ kind: 'static', allowedHosts: ['api.example.org'] },
			'cilium',
			{ namespace: NAMESPACE, name: `${TEMPLATE}-egress`, sandboxTemplateName: TEMPLATE },
		)
		cluster.policies.set(`${TEMPLATE}-egress`, translated.manifest)
		const egress = {
			engine: 'cilium' as const,
			policy: { kind: 'static' as const, allowedHosts: ['api.example.org'] },
		}
		const config = {
			...publicConfig(true),
			egress: { ...publicConfig(true).egress, ...egress },
		}
		const first = await createKubernetesWorkspace(config, {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await first.setNetworkPolicy?.({ allowedHosts: [REGISTRY] })
		const listsBefore = cluster.server
			.matching('GET', '/ciliumnetworkpolicies')
			.filter((r) => r.path.endsWith('/ciliumnetworkpolicies')).length

		const second = await createKubernetesWorkspace(config, {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		expect(second.origin).toBe('adopted-running')
		// The union check DID run on the reopen (it enumerated the policies)...
		expect(
			cluster.server
				.matching('GET', '/ciliumnetworkpolicies')
				.filter((r) => r.path.endsWith('/ciliumnetworkpolicies')).length,
		).toBeGreaterThan(listsBefore)
		// ...and the grant survived it.
		expect(cluster.policies.has(`namzu-sbx-${SANDBOX_UID}`)).toBe(true)
		await second.destroy()
	})

	it('refuses to adopt a workspace created without the per-sandbox label, patching nothing', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const plain = await open(false)
		await plain.suspend()
		const patchesBefore = cluster.server.matching('PATCH', '/sandboxes/').length

		const failure = await open(true).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		expect((failure as KubernetesWorkspaceMismatchError).field).toBe('perSandboxLabel')
		expect(cluster.server.matching('PATCH', '/sandboxes/')).toHaveLength(patchesBefore)
	})
})

/**
 * The request log of create, suspend, resume and a deleting destroy, recorded
 * against the workspace path as it stood BEFORE #618 (4f07fdf8f). A byte-for-byte
 * claim has to be made against something that was not written by the change.
 */
const GOLDEN_WITHOUT_PER_SANDBOX: string[] = [
	'GET /apis/networking.k8s.io/v1/namespaces/namzu-sandboxes/networkpolicies/namzu-workspace-egress',
	'GET /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxtemplates/namzu-workspace',
	'GET /apis/networking.k8s.io/v1/namespaces/namzu-sandboxes/networkpolicies',
	'POST /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes',
	'GET /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'GET /api/v1/namespaces/namzu-sandboxes/pods/namzu-ws-long-lived',
	'GET /api/v1/namespaces/namzu-sandboxes/persistentvolumeclaims/workspace-namzu-ws-long-lived',
	'GET /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'PATCH /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'GET /api/v1/namespaces/namzu-sandboxes/pods/namzu-ws-long-lived',
	'GET /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'PATCH /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'GET /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
	'GET /api/v1/namespaces/namzu-sandboxes/pods/namzu-ws-long-lived',
	'GET /api/v1/namespaces/namzu-sandboxes/pods?labelSelector=agents.x-k8s.io%2Fsandbox-name-hash%3Dllv',
	'DELETE /apis/agents.x-k8s.io/v1beta1/namespaces/namzu-sandboxes/sandboxes/namzu-ws-long-lived',
]

describe('without perSandbox the workspace path is unchanged', () => {
	it('sends no fence, policy or per-sandbox label request, and no setNetworkPolicy', async () => {
		if (!cluster || !agent) throw new Error('fixtures not started')
		const workspace = await open(false)
		await workspace.suspend()
		agent.setToken(SECOND_POD_UID)
		await workspace.resume()
		await workspace.destroy({ deleteDisk: true })

		expect(workspace.setNetworkPolicy).toBeUndefined()
		const log = cluster.server.requests.map((r) => `${r.method} ${r.path}`)
		expect(log.filter((l) => l.includes('validatingadmission'))).toEqual([])
		expect(log.filter((l) => l.includes('ciliumnetworkpolicies'))).toEqual([])
		expect(sandboxPost().spec.podTemplate.metadata.labels).toEqual(TEMPLATE_LABEL)
		expect(log).toEqual(GOLDEN_WITHOUT_PER_SANDBOX)
	})
})

describe('the execution profile', () => {
	/** Resolved against the path as it stood before #618 (4f07fdf8f). */
	const NO_PER_SANDBOX_FINGERPRINT =
		'sha256:226738ed4a89e8a05d1d6ba2459b1d6344f3d4ca04f87b6a10c2284f84d349f6'

	it('keeps the fingerprint of a configuration without perSandbox, and names no variant', async () => {
		const profile = await resolveKubernetesExecutionProfile(publicConfig(false))

		expect(profile.variant).toBeUndefined()
		expect(profile.content).not.toHaveProperty('variant')
		expect(profile.content).not.toHaveProperty('perSandbox')
		expect(profile.fingerprint).toBe(NO_PER_SANDBOX_FINGERPRINT)
	})

	it('distinguishes the core/no-network+per-sandbox variant', async () => {
		const plain = await resolveKubernetesExecutionProfile(publicConfig(false))
		const variant = await resolveKubernetesExecutionProfile(publicConfig(true))

		expect(variant.variant).toBe(KUBERNETES_PER_SANDBOX_PROFILE_VARIANT)
		expect(variant.variant).toBe('core/no-network+per-sandbox')
		expect(variant.fingerprint).not.toBe(plain.fingerprint)
		expect(variant.content.variant).toBe('core/no-network+per-sandbox')
	})

	it('changes the fingerprint when anything the per-sandbox writes depend on changes', async () => {
		const base = await resolveKubernetesExecutionProfile(publicConfig(true))
		const otherFence = await resolveKubernetesExecutionProfile({
			...publicConfig(true),
			egress: {
				policy: { kind: 'no-network' as const },
				perSandbox: {
					engine: 'cilium' as const,
					admissionPolicyName: ADMISSION_POLICY,
					labelKey: 'sandbox.namzu.ai/other',
				},
			},
		})

		expect(otherFence.fingerprint).not.toBe(base.fingerprint)
	})

	it('is admitted only when the fence verifies, and yields no fingerprint otherwise', async () => {
		if (!cluster) throw new Error('fixtures not started')
		cluster.fenceMode.current = 'no-binding'

		const failure = await resolveKubernetesExecutionProfile(publicConfig(true)).catch(
			(err: unknown) => err,
		)

		expect(failure).toBeInstanceOf(KubernetesAdmissionFenceMissingError)
	})

	it('names the variant only over a core no-network baseline', async () => {
		const deny = await resolveKubernetesExecutionProfile({
			...publicConfig(true),
			egress: {
				policy: { kind: 'deny-all' as const },
				perSandbox: { engine: 'cilium' as const, admissionPolicyName: ADMISSION_POLICY },
			},
		})

		expect(deny.variant).toBeUndefined()
		expect(deny.content).toHaveProperty('perSandbox')
	})

	it('has a fingerprint that does not depend on the workspace, though the revision does', async () => {
		const generic = await resolveKubernetesExecutionProfile(publicConfig(true))
		const named = await resolveKubernetesExecutionProfile(publicConfig(true), {
			workspaceId: WORKSPACE_ID,
		})

		expect(named.fingerprint).toBe(generic.fingerprint)
		expect(named.podTemplateHash).not.toBe(generic.podTemplateHash)
	})

	it('allocates under the variant: the label is stamped, and the standing object is then adopted', async () => {
		if (!cluster) throw new Error('fixtures not started')
		const profile = await resolveKubernetesExecutionProfile(publicConfig(true))

		const result = await allocateKubernetesWorkspace(publicConfig(true), {
			workspaceId: WORKSPACE_ID,
			allocation: {
				id: 'alloc-1',
				scopeFingerprint: 'scope-1',
				executionProfile: profile.fingerprint,
			},
		})

		expect(result.outcome).toBe('created')
		expect(sandboxPost().spec.podTemplate.metadata.labels).toEqual({
			...TEMPLATE_LABEL,
			[LABEL_KEY]: WORKSPACE_NAME,
		})
		const opened = await open()
		expect(opened.origin).toBe('adopted-running')
		expect(typeof opened.setNetworkPolicy).toBe('function')
		await opened.destroy()
	})
})
