/**
 * A workspace id is a deterministic NAME, so it addresses whatever Sandbox
 * stands under it now. These cases pin the three things that follow from
 * that:
 *
 *  - a lifecycle write is conditioned on the Sandbox uid it was meant for —
 *    `test /metadata/uid` in the JSON patch, `preconditions.uid` on the
 *    DELETE — so a same-name replacement is refused with ZERO mutation, and
 *    never retried against its new owner. A handle does this without being
 *    asked, with the uid it bound (issue 589's follow-up); the standalone
 *    verbs take it as `expectedIdentity` (issue 597).
 *  - `inspect`, `open` and `reconcile` are GET-only: every case that reaches
 *    them asserts the whole request log is GETs.
 *  - readiness is not ownership. A `resourceVersion` that moves, a `Ready`
 *    that flips and a `Ready` left over from an earlier generation are
 *    progress; only a different uid (Sandbox or claim) or owner is refused.
 *
 * No case decides its outcome by racing the clock. Progress is scripted by
 * the Nth GET (a hook on the fake), cancellation fires from inside a request,
 * and the one timeout case can only ever time out.
 *
 * The fake applies real RFC 6902 `test`/`add` semantics and answers an
 * unapplied patch with the opaque 422 a real API server does.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type KubernetesBackendConfig,
	KubernetesWorkspaceIdentityMismatchError,
	KubernetesWorkspacePreconditionError,
	KubernetesWorkspaceReadyTimeoutError,
	KubernetesWorkspaceReplacedError,
	createKubernetesWorkspace,
	deleteKubernetesWorkspace,
	inspectKubernetesWorkspace,
	openKubernetesWorkspace,
	reconcileKubernetesWorkspace,
	suspendKubernetesWorkspace,
} from '../../../index.js'

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
const WORKSPACE_ID = 'shared-desk'
const WORKSPACE_NAME = 'namzu-ws-shared-desk'
const TEMPLATE_NAME = 'namzu-workspace'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=shd'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
const EPOCH_KEY = 'sandbox.namzu.ai/holder-epoch'
const SANDBOX_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SANDBOX_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CLAIM_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CLAIM_B = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const POD_UID = '11111111-1111-4111-8111-111111111111'
const JSON_PATCH = 'application/json-patch+json'
const CLAIM_PATH_TAIL = `workspace-${WORKSPACE_NAME}`

const TEMPLATE = {
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
						image: 'namzu/agent:test',
						volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
					},
				],
			},
		},
	},
}

type Obj = Record<string, unknown>

interface Claim {
	uid: string
	ownerUid?: string
}

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

let sandbox: Obj | undefined
let claim: Claim | undefined
let podUid: string | undefined
let rvSeq: number
let sandboxGets: number
/** Runs before the Nth sandbox GET answers, so progress is a function of the call count. */
let onSandboxGet: ((n: number) => void) | undefined
/** Runs before the first sandbox PATCH or DELETE is evaluated: a replacement landing mid-write. */
let beforeWrite: (() => void) | undefined
let resetOn: string | undefined
let failSandboxGets: boolean

beforeEach(() => {
	sandbox = undefined
	claim = undefined
	podUid = undefined
	rvSeq = 1000
	sandboxGets = 0
	onSandboxGet = undefined
	beforeWrite = undefined
	resetOn = undefined
	failSandboxGets = false
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function nextRv(): string {
	rvSeq += 1
	return String(rvSeq)
}

function sandboxObject(
	uid: string,
	options: { epoch?: number; mode?: 'Running' | 'Suspended'; ready?: boolean } = {},
): Obj {
	return {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: {
			name: WORKSPACE_NAME,
			namespace: NAMESPACE,
			uid,
			generation: 1,
			resourceVersion: nextRv(),
			annotations:
				options.epoch !== undefined ? { [EPOCH_KEY]: String(options.epoch) } : { 'x/y': 'z' },
		},
		spec: {
			operatingMode: options.mode ?? 'Running',
			volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				spec: TEMPLATE.spec.podTemplate.spec,
			},
		},
		status: {
			conditions: [
				{ ...readyCondition(options.ready === false ? 'False' : 'True'), observedGeneration: 1 },
			],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
}

function meta(o: Obj): Obj {
	return o.metadata as Obj
}

function spec(o: Obj): Obj {
	return o.spec as Obj
}

function seed(
	uid = SANDBOX_A,
	options: { epoch?: number; mode?: 'Running' | 'Suspended'; ready?: boolean } = {},
): void {
	sandbox = sandboxObject(uid, options)
	claim = { uid: CLAIM_A, ownerUid: uid }
	podUid = options.mode === 'Suspended' ? undefined : POD_UID
}

/** Swap in a same-name stranger, as a delete-and-recreate would. */
function replaceWith(uid: string, options: { epoch?: number } = {}): void {
	sandbox = sandboxObject(uid, options)
	claim = { uid: CLAIM_B, ownerUid: uid }
}

// --- RFC 6902: all or nothing, `test` compares, a failure is the opaque 422 -

interface PatchOp {
	readonly op: string
	readonly path: string
	readonly value: unknown
}

function tokens(pointer: string): string[] {
	return pointer
		.split('/')
		.slice(1)
		.map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function applyJsonPatch(object: Obj, ops: readonly PatchOp[]): boolean {
	const draft = JSON.parse(JSON.stringify(object)) as Obj
	for (const op of ops) {
		const parts = tokens(op.path)
		if (op.op === 'test') {
			let cursor: unknown = draft
			for (const t of parts) {
				if (typeof cursor !== 'object' || cursor === null) return false
				cursor = (cursor as Obj)[t]
			}
			if (JSON.stringify(cursor) !== JSON.stringify(op.value)) return false
			continue
		}
		if (op.op !== 'add') return false
		const last = parts.pop()
		let cursor: unknown = draft
		for (const t of parts) {
			if (typeof cursor !== 'object' || cursor === null) return false
			cursor = (cursor as Obj)[t]
		}
		if (last === undefined || typeof cursor !== 'object' || cursor === null) return false
		;(cursor as Obj)[last] = op.value
	}
	meta(draft).resourceVersion = nextRv()
	Object.assign(object, draft)
	return true
}

const PATCH_NOT_APPLIED: FakeApiReply = {
	status: 422,
	body: {
		kind: 'Status',
		apiVersion: 'v1',
		metadata: {},
		status: 'Failure',
		message: 'the server rejected our request due to an error in our request',
		reason: 'Invalid',
		details: {},
		code: 422,
	},
}

function handle(req: RecordedRequest): FakeApiReply {
	if (resetOn !== undefined && req.path.includes(resetOn)) return { status: 500, reset: true }
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		if (sandbox !== undefined) {
			return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
		}
		seed(SANDBOX_A)
		return { status: 201, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/persistentvolumeclaims/')) {
		if (claim === undefined || !req.path.endsWith(CLAIM_PATH_TAIL)) {
			return { status: 404, body: { message: 'gone' } }
		}
		return {
			status: 200,
			body: {
				metadata: {
					name: CLAIM_PATH_TAIL,
					uid: claim.uid,
					...(claim.ownerUid !== undefined
						? { ownerReferences: [{ uid: claim.ownerUid, controller: true }] }
						: {}),
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		return {
			status: 200,
			body: {
				items: podUid
					? [{ metadata: { name: WORKSPACE_NAME, uid: podUid }, status: { phase: 'Running' } }]
					: [],
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (podUid === undefined) return { status: 404, body: { message: 'gone' } }
		return {
			status: 200,
			body: { metadata: { name: WORKSPACE_NAME, uid: podUid }, status: { phase: 'Running' } },
		}
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		sandboxGets += 1
		onSandboxGet?.(sandboxGets)
		if (failSandboxGets) return { status: 500, body: { message: 'boom' } }
		if (sandbox === undefined) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: sandbox }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const write = beforeWrite
		beforeWrite = undefined
		write?.()
		if (sandbox === undefined) return { status: 404, body: { message: 'gone' } }
		if (req.contentType !== JSON_PATCH) {
			spec(sandbox).operatingMode = (
				req.body as { spec: { operatingMode: string } }
			).spec.operatingMode
			return { status: 200, body: sandbox }
		}
		if (!applyJsonPatch(sandbox, req.body as PatchOp[])) return PATCH_NOT_APPLIED
		if (spec(sandbox).operatingMode === 'Suspended') podUid = undefined
		return { status: 200, body: sandbox }
	}
	if (req.method === 'DELETE' && req.path.includes('/sandboxes/')) {
		const write = beforeWrite
		beforeWrite = undefined
		write?.()
		if (sandbox === undefined) return { status: 404, body: { message: 'gone' } }
		const pre = (
			req.body as { preconditions?: { uid?: string; resourceVersion?: string } } | undefined
		)?.preconditions
		if (pre?.uid !== undefined && pre.uid !== meta(sandbox).uid) {
			return { status: 409, body: { message: 'Precondition failed: UID in precondition' } }
		}
		if (
			pre?.resourceVersion !== undefined &&
			pre.resourceVersion !== meta(sandbox).resourceVersion
		) {
			return { status: 409, body: { message: 'the ResourceVersion in the precondition' } }
		}
		sandbox = undefined
		podUid = undefined
		return { status: 200, body: { kind: 'Status' } }
	}
	return { status: 404, body: { message: 'unexpected' } }
}

async function start(withAgent = false): Promise<void> {
	if (withAgent) {
		agent = await startScriptedAgent({ token: POD_UID })
		restoreDns = stubLoopbackDns()
	}
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
		...(agent ? { agentPort: agent.port } : {}),
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

function mutations(): readonly RecordedRequest[] {
	return requests().filter((r) => r.method !== 'GET')
}

function expectGetOnly(): void {
	expect(mutations()).toEqual([])
}

function modeOf(): unknown {
	return sandbox === undefined ? undefined : spec(sandbox).operatingMode
}

describe('a standalone lifecycle write with expectedIdentity', () => {
	it('suspend tests the Sandbox uid inside the one JSON patch', async () => {
		seed(SANDBOX_A)
		await start()
		await suspendKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		})
		const patches = requests().filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.contentType).toBe(JSON_PATCH)
		const ops = patches[0]?.body as PatchOp[]
		expect(ops[0]).toEqual({ op: 'test', path: '/metadata/uid', value: SANDBOX_A })
		// The test precedes every mutation (RFC 6902 applies in order).
		expect(ops.findIndex((o) => o.op === 'add')).toBeGreaterThan(0)
		expect(modeOf()).toBe('Suspended')
	})

	it.each([
		['no epoch on the stranger', undefined, undefined],
		['a lower epoch on the stranger', 3, 7],
		['a lower epoch on the stranger, no epoch on the call', 3, undefined],
	])(
		'suspend of a replacement with %s sends zero mutations',
		async (_label, strangerEpoch, callEpoch) => {
			seed(SANDBOX_A)
			replaceWith(SANDBOX_B, strangerEpoch !== undefined ? { epoch: strangerEpoch } : {})
			await start()
			const refusal = await suspendKubernetesWorkspace(config(), WORKSPACE_ID, {
				expectedIdentity: { sandboxUid: SANDBOX_A },
				...(callEpoch !== undefined ? { epoch: callEpoch } : {}),
			}).catch((e: unknown) => e)
			expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
			const replaced = refusal as KubernetesWorkspaceReplacedError
			expect(replaced.expectedSandboxUid).toBe(SANDBOX_A)
			expect(replaced.actualSandboxUid).toBe(SANDBOX_B)
			expectGetOnly()
			expect(modeOf()).toBe('Running')
		},
	)

	it('suspend whose target is replaced between the read and the write is refused by the server and never retried', async () => {
		seed(SANDBOX_A)
		await start()
		// The caller's read sees A; the replacement lands before the patch does.
		beforeWrite = () => replaceWith(SANDBOX_B)
		const refusal = await suspendKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect((refusal as KubernetesWorkspaceReplacedError).actualSandboxUid).toBe(SANDBOX_B)
		// Exactly one patch was ever sent, the server did not apply it, and
		// the stranger was not written to.
		expect(requests().filter((r) => r.method === 'PATCH')).toHaveLength(1)
		expect(modeOf()).toBe('Running')
		expect(requests().some((r) => r.method === 'DELETE')).toBe(false)
	})

	it('suspend with a malformed expectedIdentity is refused before any request', async () => {
		seed(SANDBOX_A)
		await start()
		await expect(
			suspendKubernetesWorkspace(config(), WORKSPACE_ID, {
				expectedIdentity: { sandboxUid: '' },
			}),
		).rejects.toThrow(TypeError)
		expect(requests()).toHaveLength(0)
	})

	it('delete sends preconditions.uid, and removes the matching Sandbox', async () => {
		seed(SANDBOX_A, { mode: 'Suspended' })
		await start()
		await deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		})
		const deletes = requests().filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.body).toEqual({
			apiVersion: 'v1',
			kind: 'DeleteOptions',
			preconditions: { uid: SANDBOX_A },
		})
		expect(sandbox).toBeUndefined()
	})

	it('delete of a replacement already standing is refused by the server precondition, and the stranger survives', async () => {
		seed(SANDBOX_A, { mode: 'Suspended' })
		replaceWith(SANDBOX_B)
		await start()
		const refusal = await deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect(sandbox).toBeDefined()
		// One DELETE, refused; never repeated against the new owner.
		expect(requests().filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('delete whose target is replaced mid-flight does not take the new disk', async () => {
		seed(SANDBOX_A, { mode: 'Suspended' })
		await start()
		beforeWrite = () => replaceWith(SANDBOX_B)
		const refusal = await deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect(meta(sandbox as Obj).uid).toBe(SANDBOX_B)
		expect(requests().filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('delete of an already-absent workspace still counts as deleted', async () => {
		await start()
		await expect(
			deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
				expectedIdentity: { sandboxUid: SANDBOX_A },
			}),
		).resolves.toBeUndefined()
	})

	it('delete under an epoch carries both the version and the uid, and refuses a lower-epoch stranger with no DELETE', async () => {
		seed(SANDBOX_A, { epoch: 5 })
		await start()
		await deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
			epoch: 5,
			expectedIdentity: { sandboxUid: SANDBOX_A },
		})
		const pre = (
			requests().find((r) => r.method === 'DELETE')?.body as {
				preconditions: Record<string, string>
			}
		).preconditions
		expect(pre.uid).toBe(SANDBOX_A)
		expect(pre.resourceVersion).toBeDefined()
	})

	it('delete of a replacement at a lower epoch sends zero mutations', async () => {
		seed(SANDBOX_A)
		replaceWith(SANDBOX_B, { epoch: 3 })
		await start()
		const refusal = await deleteKubernetesWorkspace(config(), WORKSPACE_ID, {
			epoch: 7,
			expectedIdentity: { sandboxUid: SANDBOX_A },
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expectGetOnly()
		expect(sandbox).toBeDefined()
	})

	it('a lost reply is an unknown result: it rejects as itself, with no second write', async () => {
		seed(SANDBOX_A)
		await start()
		resetOn = '/sandboxes/'
		// Every sandbox request now loses its connection; the first one is
		// the read the fenced write is conditioned on.
		const failure = await suspendKubernetesWorkspace(config(), WORKSPACE_ID, {
			expectedIdentity: { sandboxUid: SANDBOX_A },
		}).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect(requests().some((r) => r.method === 'PATCH')).toBe(false)
	})
})

describe('a handle fences its own writes with the uid it bound', () => {
	async function openHandle(epoch?: number) {
		return await createKubernetesWorkspace(config({ readyTimeoutMs: 4_000 }), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			...(epoch !== undefined ? { epoch } : {}),
		})
	}

	it.each([
		['no epoch', undefined],
		['epoch 3', 3],
	])(
		'suspend() against a replacement with %s sends zero mutations',
		async (_l, strangerEpoch) => {
			seed(SANDBOX_A, strangerEpoch !== undefined ? { epoch: 0 } : {})
			await start(true)
			const held = await openHandle(7)
			expect(held.identity.sandboxUid).toBe(SANDBOX_A)
			const before = mutations().length
			replaceWith(SANDBOX_B, strangerEpoch !== undefined ? { epoch: strangerEpoch } : {})
			const refusal = await held.suspend({ flush: false }).catch((e: unknown) => e)
			expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
			expect(mutations()).toHaveLength(before)
			expect(modeOf()).toBe('Running')
			expect(held.suspended).toBe(false)
		},
		30_000,
	)

	it.each([
		['no epoch', undefined],
		['epoch 3', 3],
	])(
		'destroy({ deleteDisk }) against a replacement with %s sends no DELETE',
		async (_l, strangerEpoch) => {
			seed(SANDBOX_A, strangerEpoch !== undefined ? { epoch: 0 } : {})
			await start(true)
			const held = await openHandle(7)
			replaceWith(SANDBOX_B, strangerEpoch !== undefined ? { epoch: strangerEpoch } : {})
			const refusal = await held.destroy({ deleteDisk: true }).catch((e: unknown) => e)
			expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
			expect(requests().some((r) => r.method === 'DELETE')).toBe(false)
			expect(sandbox).toBeDefined()
		},
		30_000,
	)

	it('a handle with no epoch is fenced by the uid alone, and its normal suspend still works', async () => {
		seed(SANDBOX_A)
		await start(true)
		const held = await openHandle()
		await held.suspend({ flush: false })
		const patch = requests()
			.filter((r) => r.method === 'PATCH')
			.at(-1)
		expect(patch?.contentType).toBe(JSON_PATCH)
		expect((patch?.body as PatchOp[])[0]).toEqual({
			op: 'test',
			path: '/metadata/uid',
			value: SANDBOX_A,
		})
		expect(modeOf()).toBe('Suspended')
	}, 30_000)

	it('a replacement landing between the handle’s read and its patch is refused, not written', async () => {
		seed(SANDBOX_A)
		await start(true)
		const held = await openHandle()
		beforeWrite = () => replaceWith(SANDBOX_B)
		const refusal = await held.suspend({ flush: false }).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceReplacedError)
		expect(modeOf()).toBe('Running')
		expect(held.suspended).toBe(false)
	}, 30_000)
})

describe('inspectKubernetesWorkspace', () => {
	it('reports the uids, pod, mode and epoch, using GET requests only', async () => {
		seed(SANDBOX_A, { epoch: 4 })
		await start()
		const seen = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 4 })
		expect(seen).toMatchObject({
			workspaceId: WORKSPACE_ID,
			operatingMode: 'Running',
			holderEpoch: 4,
			ready: true,
			missingVolumeClaims: [],
			identity: {
				sandboxUid: SANDBOX_A,
				volumeClaimUids: { workspace: CLAIM_A },
				podUid: POD_UID,
				guestBootId: undefined,
			},
		})
		expectGetOnly()
	})

	it('leaves a suspended workspace suspended and reports no pod', async () => {
		seed(SANDBOX_A, { mode: 'Suspended' })
		await start()
		const seen = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 0 })
		expect(seen?.operatingMode).toBe('Suspended')
		expect(seen?.identity.podUid).toBeUndefined()
		expect(seen?.ready).toBe(false)
		expectGetOnly()
		expect(modeOf()).toBe('Suspended')
	})

	it('resolves undefined when nothing stands there, and creates nothing', async () => {
		await start()
		expect(await inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 1 })).toBeUndefined()
		expectGetOnly()
	})

	it('refuses a superseded reader and a Ready left from an earlier generation is not Ready', async () => {
		seed(SANDBOX_A, { epoch: 9 })
		await start()
		await expect(
			inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 2 }),
		).rejects.toBeInstanceOf(KubernetesWorkspacePreconditionError)
		meta(sandbox as Obj).generation = 2
		const seen = await inspectKubernetesWorkspace(config(), WORKSPACE_ID, { epoch: 9 })
		expect(seen?.ready).toBe(false)
		expectGetOnly()
	})
})

describe('openKubernetesWorkspace', () => {
	const retained = { sandboxUid: SANDBOX_A, volumeClaimUids: { workspace: CLAIM_A } }

	it('authenticates the exact identity in one GET-only pass', async () => {
		seed(SANDBOX_A)
		await start()
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
		})
		expect(opened.identity.sandboxUid).toBe(SANDBOX_A)
		expectGetOnly()
	})

	it.each([
		['sandbox-uid', () => replaceWith(SANDBOX_B), undefined],
		['sandbox-uid', () => replaceWith(SANDBOX_B, { epoch: 3 }), 7],
		[
			'volume-claim-uid',
			() => {
				;(claim as Claim).uid = CLAIM_B
			},
			undefined,
		],
		[
			'volume-claim-owner',
			() => {
				;(claim as Claim).ownerUid = SANDBOX_B
			},
			undefined,
		],
		[
			'sandbox-absent',
			() => {
				sandbox = undefined
			},
			undefined,
		],
	])('refuses %s with zero mutation requests', async (kind, change, epoch) => {
		seed(SANDBOX_A)
		change()
		await start()
		const refusal = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: epoch ?? 0,
			waitForReady: true,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceIdentityMismatchError)
		expect((refusal as KubernetesWorkspaceIdentityMismatchError).mismatch).toBe(kind)
		expectGetOnly()
	})

	it('moves of resourceVersion alone are progress, not a conflict', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		onSandboxGet = (n) => {
			meta(sandbox as Obj).resourceVersion = nextRv()
			if (n === 4) {
				;(sandbox as Obj & { status: { conditions: unknown[] } }).status.conditions = [
					{ ...readyCondition('True'), observedGeneration: 1 },
				]
			}
		}
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		})
		expect(opened.ready).toBe(true)
		expect(sandboxGets).toBeGreaterThanOrEqual(4)
		expectGetOnly()
	})

	it('a Ready flip alone between two passes is progress', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		onSandboxGet = (n) => {
			if (n === 2) {
				;(sandbox as Obj & { status: { conditions: unknown[] } }).status.conditions = [
					{ ...readyCondition('True'), observedGeneration: 1 },
				]
			}
		}
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		})
		expect(opened.ready).toBe(true)
		expectGetOnly()
	})

	it('keeps waiting through a previous generation’s Ready, then succeeds when the current one is observed', async () => {
		seed(SANDBOX_A)
		meta(sandbox as Obj).generation = 2
		await start()
		onSandboxGet = (n) => {
			if (n === 3) {
				;(sandbox as Obj & { status: { conditions: unknown[] } }).status.conditions = [
					{ ...readyCondition('True'), observedGeneration: 2 },
				]
			}
		}
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		})
		expect(opened.ready).toBe(true)
		expect(sandboxGets).toBeGreaterThanOrEqual(3)
		expectGetOnly()
	})

	it('waits for claims that do not exist yet, and retains each uid it sees', async () => {
		seed(SANDBOX_A)
		claim = undefined
		await start()
		onSandboxGet = (n) => {
			if (n === 2) claim = { uid: CLAIM_A, ownerUid: SANDBOX_A }
		}
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: { sandboxUid: SANDBOX_A },
			epoch: 1,
			waitForReady: true,
		})
		expect(opened.identity.volumeClaimUids).toEqual({ workspace: CLAIM_A })
		expectGetOnly()
	})

	it('a claim replaced after it was seen is a refusal, not a longer wait', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		onSandboxGet = (n) => {
			if (n === 2) (claim as Claim).uid = CLAIM_B
		}
		const refusal = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: { sandboxUid: SANDBOX_A },
			epoch: 1,
			waitForReady: true,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceIdentityMismatchError)
		expect((refusal as KubernetesWorkspaceIdentityMismatchError).mismatch).toBe('volume-claim-uid')
		expect((refusal as KubernetesWorkspaceIdentityMismatchError).expected).toBe(CLAIM_A)
		expectGetOnly()
	})

	it('a Sandbox replaced while waiting is a refusal', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		onSandboxGet = (n) => {
			if (n === 3) replaceWith(SANDBOX_B)
		}
		const refusal = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		}).catch((e: unknown) => e)
		expect(refusal).toBeInstanceOf(KubernetesWorkspaceIdentityMismatchError)
		expectGetOnly()
	})

	it('never wakes a suspended workspace: it returns it as suspended at once', async () => {
		seed(SANDBOX_A, { mode: 'Suspended', ready: false })
		await start()
		const opened = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		})
		expect(opened.operatingMode).toBe('Suspended')
		expect(sandboxGets).toBe(1)
		expectGetOnly()
	})

	it('running out of time is its own error, and ownership is never blamed', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		const failure = await openKubernetesWorkspace(config({ readyTimeoutMs: 100 }), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
		}).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(KubernetesWorkspaceReadyTimeoutError)
		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceIdentityMismatchError)
		expect((failure as KubernetesWorkspaceReadyTimeoutError).waitingFor).toContain(
			'ready-condition',
		)
		expectGetOnly()
	})

	it('cancellation rejects with the caller’s reason, never as a mismatch or a timeout', async () => {
		seed(SANDBOX_A, { ready: false })
		await start()
		const stop = new AbortController()
		const reason = new Error('host is shutting down')
		onSandboxGet = (n) => {
			if (n === 2) stop.abort(reason)
		}
		const failure = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
			waitForReady: true,
			signal: stop.signal,
		}).catch((e: unknown) => e)
		expect(failure).toBe(reason)
		expectGetOnly()
	})

	it('an unanswered read is an unknown result, never an ownership verdict', async () => {
		seed(SANDBOX_A)
		await start()
		resetOn = '/persistentvolumeclaims/'
		const failure = await openKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
			epoch: 1,
		}).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceIdentityMismatchError)
		expectGetOnly()
	})

	it('refuses a superseded epoch without a write', async () => {
		seed(SANDBOX_A, { epoch: 9 })
		await start()
		await expect(
			openKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				identity: retained,
				epoch: 2,
			}),
		).rejects.toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expectGetOnly()
	})
})

describe('reconcileKubernetesWorkspace', () => {
	const retained = { sandboxUid: SANDBOX_A, volumeClaimUids: { workspace: CLAIM_A } }

	it('answers live', async () => {
		seed(SANDBOX_A)
		await start()
		const closure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		})
		expect(closure.state).toBe('live')
		expectGetOnly()
	})

	it('answers suspended without waking it', async () => {
		seed(SANDBOX_A, { mode: 'Suspended' })
		await start()
		const closure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		})
		expect(closure.state).toBe('suspended')
		expectGetOnly()
		expect(modeOf()).toBe('Suspended')
	})

	it('answers absent', async () => {
		await start()
		const closure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		})
		expect(closure).toEqual({
			state: 'absent',
			workspaceId: WORKSPACE_ID,
			sandboxName: WORKSPACE_NAME,
		})
		expectGetOnly()
	})

	it('answers replaced for a different Sandbox, and for a different claim, and names which', async () => {
		seed(SANDBOX_A)
		replaceWith(SANDBOX_B)
		await start()
		const stranger = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		})
		expect(stranger).toMatchObject({ state: 'replaced', mismatch: 'sandbox-uid' })
		expect(stranger.identity?.sandboxUid).toBe(SANDBOX_B)
		seed(SANDBOX_A)
		;(claim as Claim).uid = CLAIM_B
		const otherDisk = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		})
		expect(otherDisk).toMatchObject({ state: 'replaced', mismatch: 'volume-claim-uid' })
		expectGetOnly()
	})

	it('refuses a superseded epoch rather than answering for another holder’s workspace', async () => {
		seed(SANDBOX_A, { epoch: 9 })
		await start()
		await expect(
			reconcileKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				identity: retained,
				epoch: 2,
			}),
		).rejects.toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expectGetOnly()
	})

	it('a failed read rejects as itself; it is never answered as absent', async () => {
		seed(SANDBOX_A)
		await start()
		failSandboxGets = true
		const failure = await reconcileKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			identity: retained,
		}).catch((e: unknown) => e)
		expect(failure).toBeInstanceOf(Error)
		expectGetOnly()
	})
})
