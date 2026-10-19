/**
 * `allocateKubernetesWorkspace` and the verbs around it.
 *
 *  - one create, never adopting: a same-name object is a typed conflict and
 *    the standing object is not touched;
 *  - nothing here wakes compute: the request log holds the template GET and
 *    the one POST, and no PATCH, ever;
 *  - the allocation is stored as annotations, and `inspect`, `open` and
 *    `reconcile` refuse a Sandbox whose annotations or copied template
 *    differ from `expectedAllocation`;
 *  - an unknown create reply is never retried, and is settled by reading.
 *
 * No case races the clock. The one timeout case hangs the server forever, so
 * it can only time out; every other failure is scripted by the handler.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	ALLOCATION_ID_ANNOTATION_KEY,
	ALLOCATION_SCOPE_ANNOTATION_KEY,
	EXECUTION_PROFILE_ANNOTATION_KEY,
	type KubernetesBackendConfig,
	KubernetesExecutionProfileDriftError,
	KubernetesWorkspaceAllocationConflictError,
	KubernetesWorkspaceAllocationMismatchError,
	allocateKubernetesWorkspace,
	inspectKubernetesWorkspace,
	openKubernetesWorkspace,
	reconcileKubernetesWorkspace,
	recoverKubernetesWorkspaceAllocation,
	resolveKubernetesExecutionProfile,
} from '../../../index.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'allocated-desk'
const WORKSPACE_NAME = 'namzu-ws-allocated-desk'
const TEMPLATE_NAME = 'namzu-workspace'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
const EPOCH_KEY = 'sandbox.namzu.ai/holder-epoch'
const HASH_KEY = 'sandbox.namzu.ai/pod-template-hash'
const CREATED_UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STRANGER_UID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLAIM_UID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=shd'
const CLAIM_PATH_TAIL = `workspace-${WORKSPACE_NAME}`

type Obj = Record<string, unknown>

function templateObject(image: string): Obj {
	return {
		metadata: { name: TEMPLATE_NAME, namespace: NAMESPACE },
		spec: {
			service: true,
			volumeClaimTemplates: [
				{
					metadata: { name: 'workspace' },
					spec: { accessModes: ['ReadWriteOnce'], volumeMode: 'Block' },
				},
			],
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				spec: {
					containers: [
						{
							name: 'main',
							image,
							volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
						},
					],
				},
			},
		},
	}
}

let server: FakeApiServer | undefined
let templateImage: string
let sandbox: Obj | undefined
/** What the next POST does: store the object, and how it answers. */
let onCreate:
	| { stores: boolean; reply: () => FakeApiReply | Promise<FakeApiReply> | undefined }
	| undefined
let rv: number

beforeEach(() => {
	templateImage = 'namzu/agent:one'
	sandbox = undefined
	onCreate = undefined
	rv = 100
})

afterEach(async () => {
	await server?.close()
	server = undefined
})

function nextRv(): string {
	rv += 1
	return String(rv)
}

/** A same-name Sandbox somebody else made: no allocation annotations at all. */
function seedStranger(): void {
	sandbox = {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: {
			name: WORKSPACE_NAME,
			namespace: NAMESPACE,
			uid: STRANGER_UID,
			generation: 1,
			resourceVersion: nextRv(),
			annotations: { 'x/y': 'z' },
		},
		spec: {
			operatingMode: 'Running',
			volumeClaimTemplates: (templateObject('x').spec as Obj).volumeClaimTemplates,
			podTemplate: (templateObject('namzu/agent:stranger').spec as Obj).podTemplate,
		},
	}
}

function storeFromPost(body: Obj): void {
	const metadata = body.metadata as Obj
	sandbox = {
		...body,
		metadata: {
			...metadata,
			uid: CREATED_UID,
			generation: 1,
			resourceVersion: nextRv(),
		},
		status: {
			conditions: [{ ...readyCondition('True'), observedGeneration: 1 }],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
}

function handle(req: RecordedRequest): FakeApiReply | Promise<FakeApiReply> {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: templateObject(templateImage) }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		if (sandbox !== undefined) {
			return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
		}
		const script = onCreate
		if (script?.stores !== false) storeFromPost(req.body as Obj)
		return script?.reply() ?? { status: 201, body: sandbox }
	}
	if (req.method === 'GET' && req.path.includes('/persistentvolumeclaims/')) {
		if (sandbox === undefined || !req.path.endsWith(CLAIM_PATH_TAIL)) {
			return { status: 404, body: { message: 'gone' } }
		}
		return {
			status: 200,
			body: {
				metadata: {
					name: CLAIM_PATH_TAIL,
					uid: CLAIM_UID,
					ownerReferences: [{ uid: (sandbox.metadata as Obj).uid, controller: true }],
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods')) {
		return { status: 404, body: { message: 'gone' } }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		if (sandbox === undefined) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: sandbox }
	}
	return { status: 404, body: { message: 'unexpected' } }
}

async function start(): Promise<void> {
	server = await startFakeApiServer(handle)
}

function config(extra: Partial<KubernetesBackendConfig> = {}): KubernetesBackendConfig {
	if (!server) throw new Error('fixtures not started')
	return {
		tier: 'microvm',
		service: 'kubernetes',
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TEMPLATE_NAME,
		readyTimeoutMs: 10_000,
		readyPollIntervalMs: 1,
		ingress: 'unverified' as const,
		...extra,
	}
}

function requests(): readonly RecordedRequest[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests
}

const posts = (): readonly RecordedRequest[] => requests().filter((r) => r.method === 'POST')
const nonGets = (): readonly RecordedRequest[] => requests().filter((r) => r.method !== 'GET')

const ALLOCATION = { id: 'alloc-0001', scopeFingerprint: 'scope:tenant-7/project-3' }

/** Allocate and unwrap the receipt. */
async function allocate(extra: { epoch?: number } = {}) {
	const result = await allocateKubernetesWorkspace(config(), {
		workspaceId: WORKSPACE_ID,
		allocation: ALLOCATION,
		...extra,
	})
	if (result.outcome !== 'created') throw new Error(`expected created, got ${result.outcome}`)
	return result.receipt
}

describe('resolveKubernetesExecutionProfile', () => {
	it('is read-only: one GET of the template and nothing else', async () => {
		await start()
		const profile = await resolveKubernetesExecutionProfile(config())
		expect(requests().map((r) => `${r.method} ${r.path.split('/').slice(-2).join('/')}`)).toEqual([
			`GET sandboxtemplates/${TEMPLATE_NAME}`,
		])
		expect(profile.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(profile.podTemplateHash).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(profile.content.version).toBe(1)
	})

	it('is stable across calls and moves with the template, the RuntimeClass and the egress policy', async () => {
		await start()
		const base = await resolveKubernetesExecutionProfile(config())
		expect((await resolveKubernetesExecutionProfile(config())).fingerprint).toBe(base.fingerprint)
		const withRuntime = await resolveKubernetesExecutionProfile(
			config({ runtimeClassName: 'kata' }),
		)
		const withEgress = await resolveKubernetesExecutionProfile(
			config({ egress: { policy: { kind: 'deny-all' } } }),
		)
		templateImage = 'namzu/agent:two'
		const withImage = await resolveKubernetesExecutionProfile(config())
		const all = [base, withRuntime, withEgress, withImage].map((p) => p.fingerprint)
		expect(new Set(all).size).toBe(4)
		expect(withEgress.content.egress).not.toBeNull()
		expect(nonGets()).toEqual([])
	})
})

describe('allocateKubernetesWorkspace', () => {
	it('issues exactly one create, stores the allocation, and never wakes anything', async () => {
		await start()
		const profile = await resolveKubernetesExecutionProfile(config())
		const result = await allocateKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: { ...ALLOCATION, executionProfile: profile.fingerprint },
			epoch: 4,
		})
		expect(result.outcome).toBe('created')
		if (result.outcome !== 'created') return
		expect(result.receipt).toMatchObject({
			workspaceId: WORKSPACE_ID,
			sandboxName: WORKSPACE_NAME,
			namespace: NAMESPACE,
			sandboxUid: CREATED_UID,
			epoch: 4,
			templateRevision: profile.podTemplateHash,
			allocation: { ...ALLOCATION, executionProfile: profile.fingerprint },
		})
		// The only request that is not a GET is the single create.
		expect(nonGets()).toHaveLength(1)
		expect(posts()).toHaveLength(1)
		expect(requests().some((r) => r.method === 'PATCH' || r.method === 'DELETE')).toBe(false)
		const body = posts()[0]?.body as {
			metadata: { annotations: Record<string, string> }
			spec: Obj
		}
		expect(body.metadata.annotations).toEqual({
			[EPOCH_KEY]: '4',
			[HASH_KEY]: profile.podTemplateHash,
			[ALLOCATION_ID_ANNOTATION_KEY]: ALLOCATION.id,
			[ALLOCATION_SCOPE_ANNOTATION_KEY]: ALLOCATION.scopeFingerprint,
			[EXECUTION_PROFILE_ANNOTATION_KEY]: profile.fingerprint,
		})
		expect(body.spec.operatingMode).toBe('Running')
	})

	it('names the annotations as the documented public contract', () => {
		expect(ALLOCATION_ID_ANNOTATION_KEY).toBe('sandbox.namzu.ai/allocation-id')
		expect(ALLOCATION_SCOPE_ANNOTATION_KEY).toBe('sandbox.namzu.ai/allocation-scope')
		expect(EXECUTION_PROFILE_ANNOTATION_KEY).toBe('sandbox.namzu.ai/execution-profile')
	})

	it('refuses a same-name object with a typed conflict and changes nothing', async () => {
		seedStranger()
		const before = JSON.stringify(sandbox)
		await start()
		const refusal = await allocateKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceAllocationConflictError)
		expect(refusal).toMatchObject({ workspaceId: WORKSPACE_ID, sandboxName: WORKSPACE_NAME })
		// One POST, rejected; no adoption read, no resume patch, no delete.
		expect(posts()).toHaveLength(1)
		expect(nonGets()).toHaveLength(1)
		expect(requests().some((r) => r.path.includes(`/sandboxes/${WORKSPACE_NAME}`))).toBe(false)
		expect(JSON.stringify(sandbox)).toBe(before)
	})

	it('refuses, before any create, when the profile no longer resolves to the captured one', async () => {
		await start()
		const captured = await resolveKubernetesExecutionProfile(config())
		templateImage = 'namzu/agent:two'
		const refusal = await allocateKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: { ...ALLOCATION, executionProfile: captured.fingerprint },
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesExecutionProfileDriftError)
		expect(refusal).toMatchObject({ expected: captured.fingerprint })
		expect(nonGets()).toEqual([])
		expect(sandbox).toBeUndefined()
	})

	it.each([
		['an empty id', { id: '', scopeFingerprint: 's' }],
		['an empty scope', { id: 'a', scopeFingerprint: '' }],
		['an oversized id', { id: 'x'.repeat(1025), scopeFingerprint: 's' }],
	])('refuses %s before sending anything', async (_label, allocation) => {
		await start()
		await expect(
			allocateKubernetesWorkspace(config(), { workspaceId: WORKSPACE_ID, allocation }),
		).rejects.toThrow(TypeError)
		expect(requests()).toEqual([])
	})

	it('rejects as itself when the API server answers a refusal: nothing was created', async () => {
		await start()
		onCreate = { stores: false, reply: () => ({ status: 403, body: { message: 'no' } }) }
		await expect(
			allocateKubernetesWorkspace(config(), { workspaceId: WORKSPACE_ID, allocation: ALLOCATION }),
		).rejects.toThrow(/403/)
		expect(posts()).toHaveLength(1)
	})
})

describe('an unknown create reply', () => {
	const sent = () =>
		allocateKubernetesWorkspace(config(), { workspaceId: WORKSPACE_ID, allocation: ALLOCATION })

	it.each([
		['a reset connection', { status: 500, reset: true } as FakeApiReply, 'connection'],
		['a 503', { status: 503, body: { message: 'busy' } } as FakeApiReply, 'server-error'],
		['a reply with no body', { status: 201 } as FakeApiReply, 'unreadable-reply'],
	])('after %s is unknown, is not retried, and recovers as created', async (_l, reply, reason) => {
		await start()
		onCreate = { stores: true, reply: () => reply }
		const result = await sent()
		expect(result).toMatchObject({ outcome: 'unknown', reason, workspaceId: WORKSPACE_ID })
		// The create was sent once and was not repeated.
		expect(posts()).toHaveLength(1)

		const recovery = await recoverKubernetesWorkspaceAllocation(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
		})
		expect(recovery.state).toBe('created')
		if (recovery.state !== 'created') return
		expect(recovery.receipt.sandboxUid).toBe(CREATED_UID)
		expect(recovery.receipt.allocation).toMatchObject(ALLOCATION)
		expect(posts()).toHaveLength(1)
		expect(nonGets()).toHaveLength(1)
	})

	it('recovers as absent when the lost create never landed', async () => {
		await start()
		onCreate = { stores: false, reply: () => ({ status: 500, reset: true }) }
		const result = await sent()
		expect(result.outcome).toBe('unknown')
		const recovery = await recoverKubernetesWorkspaceAllocation(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
		})
		expect(recovery).toEqual({
			state: 'absent',
			workspaceId: WORKSPACE_ID,
			sandboxName: WORKSPACE_NAME,
		})
		expect(posts()).toHaveLength(1)
	})

	it('recovers as different when another allocation stands under the name', async () => {
		await start()
		onCreate = { stores: false, reply: () => ({ status: 500, reset: true }) }
		await sent()
		seedStranger()
		const recovery = await recoverKubernetesWorkspaceAllocation(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
		})
		expect(recovery).toMatchObject({
			state: 'different',
			mismatch: 'allocation-id',
			sandboxUid: STRANGER_UID,
		})
		expect(posts()).toHaveLength(1)
	})

	it('is unknown when the caller aborts after the request was sent', async () => {
		await start()
		const controller = new AbortController()
		onCreate = {
			stores: true,
			reply: () => {
				controller.abort(new Error('caller gave up'))
				return { status: 500, reset: true }
			},
		}
		const result = await allocateKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
			signal: controller.signal,
		})
		expect(result).toMatchObject({ outcome: 'unknown', reason: 'aborted' })
		expect(posts()).toHaveLength(1)
	})

	it('is unknown when the request times out, and the create is not repeated', async () => {
		await start()
		// Never answers, so the only way out is the client's own bound.
		onCreate = { stores: false, reply: () => new Promise<FakeApiReply>(() => {}) }
		const result = await allocateKubernetesWorkspace(config({ apiRequestTimeoutMs: 1_000 }), {
			workspaceId: WORKSPACE_ID,
			allocation: ALLOCATION,
		})
		expect(result).toMatchObject({ outcome: 'unknown', reason: 'timeout' })
		expect(posts()).toHaveLength(1)
	}, 20_000)

	it('keeps a recovery that cannot read from reading as absent', async () => {
		await start()
		const bad = config({ access: { server: 'http://127.0.0.1:1', getToken: async () => 't' } })
		await expect(
			recoverKubernetesWorkspaceAllocation(bad, {
				workspaceId: WORKSPACE_ID,
				allocation: ALLOCATION,
			}),
		).rejects.toThrow()
	})
})

describe('expectedAllocation on inspect, open and reconcile', () => {
	const identity = { sandboxUid: CREATED_UID }

	async function allocated(): Promise<string> {
		await start()
		const profile = await resolveKubernetesExecutionProfile(config())
		await allocate()
		return profile.fingerprint
	}

	it('passes when the annotations and the copied template are what was allocated', async () => {
		const fingerprint = await allocated()
		const expectedAllocation = { ...ALLOCATION, executionProfile: fingerprint }
		const before = nonGets().length
		const inspected = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, {
			epoch: 1,
			expectedAllocation,
		})
		expect(inspected?.allocation).toEqual({
			id: ALLOCATION.id,
			scopeFingerprint: ALLOCATION.scopeFingerprint,
			executionProfile: fingerprint,
		})
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity,
			epoch: 1,
			expectedAllocation,
		})
		expect(opened.identity.sandboxUid).toBe(CREATED_UID)
		const closure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity,
			expectedAllocation,
		})
		expect(closure.state).toBe('live')
		expect(nonGets()).toHaveLength(before)
	})

	it('resolves an absent workspace as absent, since there is nothing to compare', async () => {
		await start()
		expect(
			await inspectKubernetesWorkspace(config(), WORKSPACE_ID, {
				epoch: 1,
				expectedAllocation: ALLOCATION,
			}),
		).toBeUndefined()
		expect(
			await reconcileKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				identity,
				expectedAllocation: ALLOCATION,
			}),
		).toMatchObject({ state: 'absent' })
	})

	function mutateStored(change: (meta: Obj, spec: Obj) => void): void {
		if (sandbox === undefined) throw new Error('nothing allocated')
		change(sandbox.metadata as Obj, sandbox.spec as Obj)
	}

	const refusals: [string, (fingerprint: string) => Obj, string][] = [
		['another allocation id', () => ({ ...ALLOCATION, id: 'alloc-0002' }), 'allocation-id'],
		[
			'another scope',
			() => ({ ...ALLOCATION, scopeFingerprint: 'scope:other' }),
			'scope-fingerprint',
		],
		[
			'another execution profile',
			() => ({ ...ALLOCATION, executionProfile: 'sha256:'.padEnd(71, '0') }),
			'execution-profile',
		],
	]

	it.each(refusals)(
		'refuses %s on all three verbs, writing nothing',
		async (_l, expected, kind) => {
			const fingerprint = await allocated()
			const expectedAllocation = expected(fingerprint) as typeof ALLOCATION
			const before = nonGets().length
			const refusal = (p: Promise<unknown>) => p.catch((e: unknown) => e)
			const results = await Promise.all([
				refusal(
					inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 1, expectedAllocation }),
				),
				refusal(
					openKubernetesWorkspace(config(), {
						workspaceId: WORKSPACE_ID,
						identity,
						epoch: 1,
						expectedAllocation,
					}),
				),
				refusal(
					reconcileKubernetesWorkspace(config(), {
						workspaceId: WORKSPACE_ID,
						identity,
						expectedAllocation,
					}),
				),
			])
			for (const r of results) {
				expect(r).toBeInstanceOf(KubernetesWorkspaceAllocationMismatchError)
				expect(r).toMatchObject({ mismatch: kind, workspaceId: WORKSPACE_ID })
			}
			expect(nonGets()).toHaveLength(before)
		},
	)

	it('refuses a copied pod template that was edited after the create', async () => {
		await allocated()
		mutateStored((_m, spec) => {
			const podTemplate = spec.podTemplate as { spec: { containers: { image: string }[] } }
			podTemplate.spec.containers[0]!.image = 'namzu/agent:tampered'
		})
		const refusal = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity,
			epoch: 1,
			expectedAllocation: ALLOCATION,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceAllocationMismatchError)
		expect(refusal).toMatchObject({ mismatch: 'template-content' })
	})

	it('refuses a template whose revision annotation was removed', async () => {
		await allocated()
		mutateStored((meta) => {
			delete (meta.annotations as Obj)[HASH_KEY]
		})
		const refusal = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, {
			epoch: 1,
			expectedAllocation: ALLOCATION,
		}).catch((e: unknown) => e)
		expect(refusal).toMatchObject({ mismatch: 'template-content' })
	})

	it('refuses a Sandbox with no allocation annotations at all', async () => {
		seedStranger()
		await start()
		const refusal = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, {
			epoch: 1,
			expectedAllocation: ALLOCATION,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceAllocationMismatchError)
		expect(refusal).toMatchObject({ mismatch: 'allocation-id', expected: ALLOCATION.id })
		expect((refusal as KubernetesWorkspaceAllocationMismatchError).actual).toBeUndefined()
	})

	it('leaves the identity answer first: a different Sandbox uid is still `replaced`', async () => {
		await allocated()
		const closure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: { sandboxUid: STRANGER_UID },
			expectedAllocation: { ...ALLOCATION, id: 'alloc-0002' },
		})
		expect(closure).toMatchObject({ state: 'replaced', mismatch: 'sandbox-uid' })
	})

	it('does not compare what it was not given', async () => {
		await allocated()
		const inspected = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 1 })
		expect(inspected?.allocation.id).toBe(ALLOCATION.id)
	})
})
