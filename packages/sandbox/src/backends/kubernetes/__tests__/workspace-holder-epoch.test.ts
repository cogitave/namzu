/**
 * Fencing a workspace's lifecycle writes with a holder epoch.
 *
 * A workspace id is a name, not a lock. Two host processes can hold handles
 * to one workspace, and until this existed every PATCH and DELETE this
 * backend sent went out unconditionally — so a host that had already decided,
 * in its own database, which process holds a workspace could still lose the
 * race: it checked its epoch, and the write that followed was a separate
 * request the API server accepted anyway. A late `suspend()` stopped the new
 * holder's pod; a late `destroy({ deleteDisk: true })` took the disk; a late
 * adopt woke a workspace that had just been suspended.
 *
 * The fence is an annotation on the Sandbox, `sandbox.namzu.ai/holder-epoch`,
 * and the rule is that a write carrying epoch `e` applies when the stored
 * epoch is `<= e` and stores `e` in the same request. Two properties carry
 * the whole design and each has its own cases below:
 *
 *  - **one request per write.** The condition and the mutation travel in one
 *    JSON Patch body, so there is no window between checking and writing.
 *    The assertions are on the raw request log: the dialect the patch went up
 *    as, the `~1`-escaped pointer, the tested value, and the count.
 *  - **nothing changes when a write is refused.** Not on the cluster, and not
 *    on the handle — the refusal is decided BEFORE terminals are reaped, so a
 *    superseded holder does not take its own caller's sessions away over a
 *    write that never applied.
 *
 * And the property that makes the feature adoptable at all, asserted here as
 * its own case rather than assumed: a call carrying NO epoch sends exactly
 * what it always sent, merge-patch content type included.
 *
 * The fake API server applies real RFC 6902 semantics — `test` compares, and
 * a failed one answers 422 with the body a real API server answers with,
 * measured against v1.37.0 and the agent-sandbox `Sandbox` CRD: an opaque
 * `Invalid` that does not name the operation that failed. That opacity is
 * load-bearing, so it is reproduced rather than idealised.
 */

import { once } from 'node:events'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type AddressInfo, type Server, type Socket, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type KubernetesBackendConfig,
	KubernetesWorkspaceAllocationConflictError,
	KubernetesWorkspacePreconditionError,
	allocateKubernetesWorkspace,
	createKubernetesWorkspace,
	deleteKubernetesWorkspace,
	inspectKubernetesWorkspaceVolume,
	listKubernetesWorkspaces,
	openKubernetesWorkspaceForClosure,
	openKubernetesWorkspaceVolumeForClosure,
	resolveKubernetesWorkspaceExecutionProfile,
	suspendKubernetesWorkspace,
} from '../../../index.js'

import { KubernetesAgentTransport } from '../transport.js'
import { AGENT_ENV_KEYS } from './fixtures/agent-env.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import {
	DEPRIVILEGED_PROC_STATUS,
	type ScriptedAgent,
	startScriptedAgent,
} from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const WORKSPACE_ID = 'shared-desk'
const WORKSPACE_NAME = 'namzu-ws-shared-desk'
const TEMPLATE_NAME = 'namzu-workspace'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=shd'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
const RETIRED_TOKEN = '99999999-9999-4999-8999-999999999999'
const SANDBOX_UID = 'sandbox-original'
const CLAIM_UID = 'claim-original'
const FIRST_BOOT = 'boot-original'
/**
 * Both annotation keys are written out rather than imported, exactly as the
 * neighbouring suites write them out: they are names that go onto a cluster
 * object and are read back by a later release, so a rename has to break a
 * test rather than follow a constant silently.
 */
const EPOCH_KEY = 'sandbox.namzu.ai/holder-epoch'
const MODE_CHANGED_AT = 'sandbox.namzu.ai/operating-mode-changed-at'
/** The same key as a JSON Pointer: `/` is `~1` (RFC 6901 §3). */
const EPOCH_POINTER = '/metadata/annotations/sandbox.namzu.ai~1holder-epoch'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
const CREATED_AT = '2026-08-01T09:00:00Z'
const MERGE_PATCH = 'application/merge-patch+json'
const JSON_PATCH = 'application/json-patch+json'

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

/** A whole Sandbox object, patched in place the way the API server patches one. */
type SandboxObject = Record<string, unknown>

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
let nativeTemplate: typeof TEMPLATE | undefined
let nativePolicy: 'closed' | 'missing' | 'wide' | 'additional' | undefined
let nativeCiliumPolicy: 'egress' | 'ingress' | 'unread' | undefined
let nativePodLabels: Record<string, string> | undefined
let nativeCiliumSelector: Record<string, string> | undefined
let beforeNativeCreate: (() => void) | undefined

let sandboxes: Map<string, SandboxObject>
let livePodUid: string | undefined
let drainingGets: number
let drainingUid: string
let nextPodUid: string
let resourceVersionSeq: number
/**
 * Bump `resourceVersion` at the START of the next PATCH, before the patch is
 * evaluated — a controller status write landing between a caller's read and
 * its write, which is the one thing that makes the migration path's
 * `resourceVersion` test fail without any holder having raced anybody.
 */
let bumpBeforeNextPatch: boolean
/** DELETEs the API server refuses with a 409 before accepting one. */
let conflictingDeletes: number
/**
 * Refuse every JSON patch with the 422 a real server answers, while changing
 * NOTHING — which from the host is indistinguishable from a malformed body,
 * and is the case the retry loop must not spin on.
 */
let refuseEveryJsonPatch: boolean
let claimUid: string
let claimOwnerUid: string
let beforePatch: (() => void) | undefined
let beforeDelete: (() => void) | undefined
let afterPatch: (() => FakeApiReply | undefined) | undefined
let afterDelete: (() => FakeApiReply | undefined) | undefined
let beforeClaimRead: (() => Promise<void>) | undefined
let beforePodRead: (() => Promise<void>) | undefined
let failPodRead: boolean
let missingClaim: boolean
let claimDeleting: boolean
let claimVersion: string
let podListReply: (() => unknown) | undefined
let afterCreate: (() => FakeApiReply | undefined) | undefined

beforeEach(async () => {
	nativeTemplate = undefined
	nativePolicy = undefined
	nativeCiliumPolicy = undefined
	nativePodLabels = undefined
	nativeCiliumSelector = undefined
	beforeNativeCreate = undefined
	sandboxes = new Map()
	livePodUid = FIRST_POD_UID
	drainingGets = 0
	drainingUid = FIRST_POD_UID
	nextPodUid = SECOND_POD_UID
	resourceVersionSeq = 1000
	bumpBeforeNextPatch = false
	conflictingDeletes = 0
	refuseEveryJsonPatch = false
	claimUid = CLAIM_UID
	claimOwnerUid = SANDBOX_UID
	beforePatch = undefined
	beforeDelete = undefined
	afterPatch = undefined
	afterDelete = undefined
	beforeClaimRead = undefined
	beforePodRead = undefined
	failPodRead = false
	missingClaim = false
	claimDeleting = false
	claimVersion = '1'
	podListReply = undefined
	afterCreate = undefined
	agent = await startScriptedAgent({
		token: FIRST_POD_UID,
		guestBootId: FIRST_BOOT,
		guestBound: true,
		sessionsReply: { ok: true, sessions: [] },
		features: ['sessions'],
	})
	restoreDns = stubLoopbackDns()
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function nextResourceVersion(): string {
	resourceVersionSeq += 1
	return String(resourceVersionSeq)
}

/** A Sandbox as the API server would serve it, before anything patched it. */
function newSandboxObject(options: { annotations?: Record<string, string> } = {}): SandboxObject {
	return {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: {
			name: WORKSPACE_NAME,
			uid: SANDBOX_UID,
			namespace: NAMESPACE,
			creationTimestamp: CREATED_AT,
			resourceVersion: nextResourceVersion(),
			// Omitted entirely when empty, as a real API server omits it —
			// which is the case that makes a patch `add` the whole map.
			...(options.annotations !== undefined ? { annotations: options.annotations } : {}),
		},
		spec: {
			operatingMode: 'Running',
			volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				spec: TEMPLATE.spec.podTemplate.spec,
			},
		},
		status: {
			conditions: [readyCondition('True')],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
}

function metaOf(object: SandboxObject): Record<string, unknown> {
	return object.metadata as Record<string, unknown>
}

function annotationsOf(object: SandboxObject): Record<string, string> | undefined {
	return metaOf(object).annotations as Record<string, string> | undefined
}

function modeOf(object: SandboxObject): string {
	return (object.spec as Record<string, unknown>).operatingMode as string
}

/** Put a workspace in the namespace, at a given mode and epoch. */
function seedWorkspace(options: { epoch?: number; mode?: 'Running' | 'Suspended' } = {}): void {
	const object = newSandboxObject(
		options.epoch !== undefined ? { annotations: { [EPOCH_KEY]: String(options.epoch) } } : {},
	)
	if (options.mode !== undefined) {
		;(object.spec as Record<string, unknown>).operatingMode = options.mode
	}
	if (options.mode === 'Suspended') livePodUid = undefined
	sandboxes.set(WORKSPACE_NAME, object)
}

// --- RFC 6902, as much of it as this backend sends -------------------------

interface PatchOperation {
	readonly op: string
	readonly path: string
	readonly value: unknown
}

/** RFC 6901 §3, backwards: `~1` is `/` and `~0` is `~`, in that order. */
function unescapeToken(token: string): string {
	return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

function pointerTokens(pointer: string): string[] {
	return pointer.split('/').slice(1).map(unescapeToken)
}

function resolvePointer(root: SandboxObject, pointer: string): unknown {
	let cursor: unknown = root
	for (const token of pointerTokens(pointer)) {
		if (typeof cursor !== 'object' || cursor === null) return undefined
		cursor = (cursor as Record<string, unknown>)[token]
	}
	return cursor
}

/**
 * Apply one operation list, ALL OR NOTHING — a patch the API server refuses
 * leaves the object exactly as it was, which is half of what "a refused write
 * changes nothing on the cluster" means and would be untestable against a
 * fake that mutated as it went.
 */
function applyJsonPatch(object: SandboxObject, operations: readonly PatchOperation[]): boolean {
	const draft = JSON.parse(JSON.stringify(object)) as SandboxObject
	for (const operation of operations) {
		if (operation.op === 'test') {
			const actual = resolvePointer(draft, operation.path)
			if (JSON.stringify(actual) !== JSON.stringify(operation.value)) return false
			continue
		}
		if (operation.op !== 'add') return false
		const tokens = pointerTokens(operation.path)
		const last = tokens.pop()
		if (last === undefined) return false
		let cursor: unknown = draft
		for (const token of tokens) {
			if (typeof cursor !== 'object' || cursor === null) return false
			cursor = (cursor as Record<string, unknown>)[token]
		}
		if (typeof cursor !== 'object' || cursor === null) return false
		;(cursor as Record<string, unknown>)[last] = operation.value
	}
	metaOf(draft).resourceVersion = nextResourceVersion()
	Object.assign(object, draft)
	return true
}

/** RFC 7386, recursing into `metadata.annotations` exactly as one does. */
function applyMergePatch(object: SandboxObject, patch: Record<string, unknown>): void {
	const patchMeta = (patch.metadata ?? {}) as {
		annotations?: Record<string, string>
	}
	if (patchMeta.annotations !== undefined) {
		metaOf(object).annotations = {
			...annotationsOf(object),
			...patchMeta.annotations,
		}
	}
	const patchSpec = (patch.spec ?? {}) as { operatingMode?: string }
	if (patchSpec.operatingMode !== undefined) {
		;(object.spec as Record<string, unknown>).operatingMode = patchSpec.operatingMode
	}
	metaOf(object).resourceVersion = nextResourceVersion()
}

/**
 * The body a real API server answers an unapplied JSON patch with — measured
 * against v1.37.0 and the `Sandbox` CRD, for a failed `test`, for a pointer
 * into a member that does not exist, and for a `test` on an absent annotation
 * key. All three are identical, which is exactly why the host cannot read the
 * reason off the reply and has to re-read the object to tell a lost race from
 * a wrong body.
 */
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

function livePod(uid: string): Record<string, unknown> {
	return {
		metadata: {
			...(nativePolicy ? { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME, ...nativePodLabels } } : {}),
			name: WORKSPACE_NAME,
			uid,
			ownerReferences: [{ uid: SANDBOX_UID, controller: true }],
		},
		status: { phase: 'Running' },
	}
}

function terminatingPod(uid: string): Record<string, unknown> {
	return {
		metadata: {
			name: WORKSPACE_NAME,
			uid,
			deletionTimestamp: '2026-09-16T00:00:01Z',
		},
		status: { phase: 'Running' },
	}
}

function objectName(path: string): string {
	const withoutQuery = path.split('?')[0] ?? ''
	return decodeURIComponent(withoutQuery.split('/').pop() ?? '')
}

/** The pod side of a mode change, shared by both patch dialects. */
function reconcileMode(previous: string, next: string): void {
	if (previous === next) return
	if (next === 'Suspended') {
		drainingUid = livePodUid ?? drainingUid
		drainingGets = 1
		livePodUid = undefined
		agent?.setToken(RETIRED_TOKEN)
	} else {
		drainingGets = 0
		livePodUid = nextPodUid
		agent?.setToken(nextPodUid)
	}
}

async function handleClusterRequest(req: RecordedRequest): Promise<FakeApiReply> {
	if (nativePolicy && req.method === 'GET' && req.path.includes('/ciliumnetworkpolicies')) {
		if (nativeCiliumPolicy === 'unread') return { status: 403, body: {} }
		return {
			status: 200,
			body: {
				items: nativeCiliumPolicy
					? [
							{
								kind: 'CiliumNetworkPolicy',
								metadata: { name: 'cilium-widening', namespace: NAMESPACE },
								spec: {
									endpointSelector: {
										matchLabels: nativeCiliumSelector ?? { [TEMPLATE_LABEL]: TEMPLATE_NAME },
									},
									...(nativeCiliumPolicy === 'egress' ? { egress: [{}] } : { ingress: [{}] }),
								},
							},
						]
					: [],
			},
		}
	}
	if (nativePolicy && req.method === 'GET' && req.path.includes('/networkpolicies')) {
		const closed = {
			apiVersion: 'networking.k8s.io/v1',
			kind: 'NetworkPolicy',
			metadata: { name: 'native-no-network', namespace: NAMESPACE },
			spec: {
				podSelector: { matchLabels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				policyTypes: ['Egress'],
				egress: nativePolicy === 'wide' ? [{}] : [],
			},
		}
		if (req.path.split('?')[0]!.endsWith('/native-no-network'))
			return nativePolicy === 'missing' ? { status: 404, body: {} } : { status: 200, body: closed }
		const ingress = {
			kind: 'NetworkPolicy',
			metadata: { name: 'agent-ingress', namespace: NAMESPACE },
			spec: {
				podSelector: { matchLabels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				policyTypes: ['Ingress'],
				ingress: [
					{
						from: [{ ipBlock: { cidr: '127.0.0.1/32' } }],
						ports: [{ protocol: 'TCP', port: agent!.port }],
					},
				],
			},
		}
		return {
			status: 200,
			body: {
				items: [
					...(nativePolicy === 'missing' ? [] : [closed]),
					ingress,
					...(nativePolicy === 'additional'
						? [
								{
									...closed,
									metadata: { name: 'widening' },
									spec: { ...closed.spec, egress: [{}] },
								},
							]
						: []),
				],
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/persistentvolumeclaims/')) {
		await beforeClaimRead?.()
		if (missingClaim) return { status: 404, body: { message: 'claim missing' } }
		return {
			status: 200,
			body: {
				metadata: {
					uid: claimUid,
					resourceVersion: claimVersion,
					...(claimDeleting ? { deletionTimestamp: CREATED_AT } : {}),
					ownerReferences: [{ uid: claimOwnerUid, controller: true }],
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: nativeTemplate ?? TEMPLATE }
	}
	if (req.method === 'GET' && req.path.endsWith('/sandboxes')) {
		return { status: 200, body: { items: [...sandboxes.values()] } }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		beforeNativeCreate?.()
		if (sandboxes.has(WORKSPACE_NAME)) {
			return {
				status: 409,
				body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` },
			}
		}
		const body = req.body as {
			metadata?: { annotations?: Record<string, string> }
		}
		sandboxes.set(
			WORKSPACE_NAME,
			newSandboxObject(
				body?.metadata?.annotations !== undefined ? { annotations: body.metadata.annotations } : {},
			),
		)
		// Profile controls model the actual immutable content the POST copied.
		if (nativeTemplate)
			sandboxes.get(WORKSPACE_NAME)!.spec = structuredClone((req.body as { spec: unknown }).spec)
		return afterCreate?.() ?? { status: 201, body: sandboxes.get(WORKSPACE_NAME) }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		beforePatch?.()
		const object = sandboxes.get(objectName(req.path))
		if (!object) return { status: 404, body: { message: 'gone' } }
		if (bumpBeforeNextPatch) {
			bumpBeforeNextPatch = false
			metaOf(object).resourceVersion = nextResourceVersion()
		}
		const before = modeOf(object)
		if (req.contentType === JSON_PATCH) {
			if (refuseEveryJsonPatch) return PATCH_NOT_APPLIED
			if (!applyJsonPatch(object, req.body as readonly PatchOperation[])) {
				return PATCH_NOT_APPLIED
			}
		} else {
			applyMergePatch(object, req.body as Record<string, unknown>)
		}
		reconcileMode(before, modeOf(object))
		const reply = afterPatch?.()
		if (reply) return reply
		return { status: 200, body: object }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		const object = sandboxes.get(objectName(req.path))
		if (!object) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: object }
	}
	if (req.method === 'DELETE' && req.path.includes('/sandboxes/')) {
		beforeDelete?.()
		const object = sandboxes.get(objectName(req.path))
		if (!object) return { status: 404, body: { message: 'gone' } }
		const preconditions = (
			req.body as { preconditions?: { resourceVersion?: string; uid?: string } } | undefined
		)?.preconditions
		if (preconditions?.uid !== undefined && preconditions.uid !== metaOf(object).uid) {
			return { status: 409, body: { message: 'UID precondition failed' } }
		}
		if (conflictingDeletes > 0) {
			conflictingDeletes -= 1
			// The message a real API server answers with, which names both
			// versions — unlike the patch refusal, this one is legible.
			return {
				status: 409,
				body: {
					message: `Operation cannot be fulfilled on Sandbox.agents.x-k8s.io "${WORKSPACE_NAME}": the ResourceVersion in the precondition does not match the ResourceVersion in record. The object might have been modified`,
				},
			}
		}
		if (
			preconditions?.resourceVersion !== undefined &&
			preconditions.resourceVersion !== metaOf(object).resourceVersion
		) {
			return {
				status: 409,
				body: { message: 'the ResourceVersion in the precondition' },
			}
		}
		sandboxes.delete(objectName(req.path))
		livePodUid = undefined
		const reply = afterDelete?.()
		if (reply) return reply
		return { status: 200, body: { kind: 'Status' } }
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (podListReply) return { status: 200, body: podListReply() }
		if (drainingGets > 0) return { status: 200, body: { items: [terminatingPod(drainingUid)] } }
		return {
			status: 200,
			body: { items: livePodUid ? [livePod(livePodUid)] : [] },
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		await beforePodRead?.()
		if (failPodRead) {
			failPodRead = false
			return {
				status: 503,
				body: { message: 'retirement observation unavailable' },
			}
		}
		if (drainingGets > 0) {
			drainingGets -= 1
			return { status: 200, body: terminatingPod(drainingUid) }
		}
		if (livePodUid === undefined) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod(livePodUid) }
	}
	return { status: 404, body: { message: 'unexpected' } }
}

function clusterConfig(): KubernetesBackendConfig {
	if (!server || !agent) throw new Error('fixtures not started')
	return {
		tier: 'microvm',
		service: 'kubernetes',
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: TEMPLATE_NAME,
		agentPort: agent.port,
		readyTimeoutMs: 1_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
	}
}

async function openWorkspace(epoch?: number) {
	return await createKubernetesWorkspace(clusterConfig(), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: '/workspace',
		...(epoch !== undefined ? { epoch } : {}),
	})
}

function requestsBy(method: string): readonly RecordedRequest[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests.filter((r) => r.method === method)
}

function sandboxPatches(): readonly RecordedRequest[] {
	return requestsBy('PATCH').filter((r) => r.path.includes('/sandboxes/'))
}

function patchOperations(request: RecordedRequest): readonly PatchOperation[] {
	return request.body as readonly PatchOperation[]
}

function storedEpoch(): string | undefined {
	const object = sandboxes.get(WORKSPACE_NAME)
	return object ? annotationsOf(object)?.[EPOCH_KEY] : undefined
}

function barrier() {
	let resolveBarrier: (() => void) | undefined
	const promise = new Promise<void>((resolve) => {
		resolveBarrier = resolve
	})
	return { promise, release: () => resolveBarrier?.() }
}

const closureIdentity = () => ({
	sandboxUid: SANDBOX_UID,
	podUid: FIRST_POD_UID,
	guestBootId: FIRST_BOOT,
	volumeClaimUids: { workspace: CLAIM_UID },
})

const openClosure = (signal?: AbortSignal) =>
	openKubernetesWorkspaceForClosure(clusterConfig(), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: '/workspace',
		identity: closureIdentity(),
		epoch: 4,
		signal,
	})

const agentOperations = () =>
	agent?.requests.map((request) =>
		request.op === 'guest-bound' ? (request.request as Record<string, unknown>).op : request.op,
	) ?? []

const volumeIdentity = () => ({
	sandboxUid: SANDBOX_UID,
	volumeClaimUids: { workspace: CLAIM_UID },
})
const volumeOptions = () => ({
	workspaceId: WORKSPACE_ID,
	workingDirectory: '/workspace',
	identity: volumeIdentity(),
	previousEpoch: 4,
	epoch: 5,
})
const openVolume = () => openKubernetesWorkspaceVolumeForClosure(clusterConfig(), volumeOptions())

describe('preserving an existing volume for closure', () => {
	it('discovers a suspended disk using only provider reads, without inventing a guest', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		expect(
			await inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
				epoch: 4,
			}),
		).toEqual({
			identity: volumeIdentity(),
			epoch: 4,
			mode: 'Suspended',
		})
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		expect(agent?.requests).toHaveLength(0)
	})

	it('wakes only the captured volume with one conditional write and binds its actual guest', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		const version = metaOf(sandboxes.get(WORKSPACE_NAME)!).resourceVersion
		const held = await openVolume()
		expect(held.identity).toEqual({
			...volumeIdentity(),
			podUid: SECOND_POD_UID,
			guestBootId: FIRST_BOOT,
		})
		expect(sandboxPatches()).toHaveLength(1)
		expect(sandboxPatches()[0]?.contentType).toBe(JSON_PATCH)
		expect(patchOperations(sandboxPatches()[0]!)).toEqual(
			expect.arrayContaining([
				{ op: 'test', path: '/metadata/uid', value: SANDBOX_UID },
				{ op: 'test', path: '/metadata/resourceVersion', value: version },
				{ op: 'test', path: EPOCH_POINTER, value: '4' },
				{ op: 'test', path: '/spec/operatingMode', value: 'Suspended' },
				{ op: 'add', path: '/spec/operatingMode', value: 'Running' },
			]),
		)
		expect(storedEpoch()).toBe('5')
		expect(requestsBy('POST')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(server?.requests.some((request) => request.path.includes('sandboxtemplates'))).toBe(
			false,
		)
		expect(agentOperations()).not.toContain('execute')
		await expect(held.resume()).rejects.toThrow()
	})

	it('recovers a lost wake reply on the same epoch without a second write', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		afterPatch = () => ({
			status: 503,
			body: { message: 'reply lost after commit' },
		})
		await expect(openVolume()).rejects.toThrow()
		expect(storedEpoch()).toBe('5')
		afterPatch = undefined
		const held = await openVolume()
		expect(held.identity?.podUid).toBe(SECOND_POD_UID)
		expect(sandboxPatches()).toHaveLength(1)
		expect(requestsBy('DELETE')).toHaveLength(0)
	})

	it.each(['cas-race', 'refused'])('does not retry or clean up a %s wake', async (kind) => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		bumpBeforeNextPatch = kind === 'cas-race'
		refuseEveryJsonPatch = kind === 'refused'
		await expect(openVolume()).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(1)
		expect(storedEpoch()).toBe('4')
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Suspended')
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agent?.requests).toHaveLength(0)
	})

	it.each(['sandbox', 'claim', 'claim-owner', 'missing-claim', 'deleting-claim'])(
		'refuses a changed %s before waking',
		async (part) => {
			seedWorkspace({ epoch: 4, mode: 'Suspended' })
			if (part === 'sandbox') metaOf(sandboxes.get(WORKSPACE_NAME)!).uid = 'foreign'
			if (part === 'claim') claimUid = 'foreign'
			if (part === 'claim-owner') claimOwnerUid = 'foreign'
			if (part === 'missing-claim') missingClaim = true
			if (part === 'deleting-claim') claimDeleting = true
			await expect(openVolume()).rejects.toThrow()
			expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
			expect(agent?.requests).toHaveLength(0)
		},
	)

	it('opens an already-running failed owner at the same epoch without relabelling it', async () => {
		seedWorkspace({ epoch: 4 })
		await expect(openVolume()).rejects.toThrow()
		const held = await openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
			...volumeOptions(),
			epoch: 4,
		})
		expect(held.identity).toEqual(closureIdentity())
		expect(sandboxPatches()).toHaveLength(0)
		expect(requestsBy('POST')).toHaveLength(0)
	})

	it('captures caller identity, workspace and epochs before asynchronous reads', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		const entered = barrier()
		const unblock = barrier()
		beforeClaimRead = async () => {
			entered.release()
			await unblock.promise
		}
		const options = volumeOptions()
		const opening = openKubernetesWorkspaceVolumeForClosure(clusterConfig(), options)
		await entered.promise
		options.workspaceId = 'foreign'
		options.identity.sandboxUid = 'foreign'
		options.identity.volumeClaimUids.workspace = 'foreign'
		options.epoch = 8
		options.previousEpoch = 9
		unblock.release()
		expect((await opening).identity?.sandboxUid).toBe(SANDBOX_UID)
		expect(storedEpoch()).toBe('5')
		expect(server?.requests.some((request) => request.path.includes('foreign'))).toBe(false)
	})

	it('retains the woken disk if cancelled before readiness without a compensating stop', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		const controller = new AbortController()
		afterPatch = () => {
			controller.abort()
			return undefined
		}
		await expect(
			openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
				...volumeOptions(),
				signal: controller.signal,
			}),
		).rejects.toThrow()
		expect(storedEpoch()).toBe('5')
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Running')
		expect(sandboxPatches()).toHaveLength(1)
		expect(requestsBy('DELETE')).toHaveLength(0)
	})

	it('retains an old-image disk whose authenticated inventory omits the boot identity', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		agent?.setGuestBootId(undefined)
		await expect(openVolume()).rejects.toThrow()
		expect(storedEpoch()).toBe('5')
		expect(sandboxPatches()).toHaveLength(1)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agentOperations()).not.toContain('execute')
	})

	it('rejects a claim changing between the two discovery reads without waking', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		let reads = 0
		beforeClaimRead = async () => {
			if (++reads === 2) claimVersion = '2'
		}
		await expect(openVolume()).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
	})

	it.each(['Suspended', 'Running'] as const)(
		'rejects a pod appearing or changing during %s inventory without changing the Sandbox version',
		async (mode) => {
			seedWorkspace({ epoch: 4, mode })
			const version = metaOf(sandboxes.get(WORKSPACE_NAME)!).resourceVersion
			let reads = 0
			beforeClaimRead = async () => {
				if (++reads === 2) livePodUid = SECOND_POD_UID
			}
			await expect(
				inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
					epoch: 4,
				}),
			).rejects.toThrow()
			expect(metaOf(sandboxes.get(WORKSPACE_NAME)!).resourceVersion).toBe(version)
			expect(sandboxPatches()).toHaveLength(0)
			expect(agent?.requests).toHaveLength(0)
		},
	)

	it('does not wake when a live pod appears after the first inventory', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		let reads = 0
		beforeClaimRead = async () => {
			if (++reads === 2) livePodUid = SECOND_POD_UID
		}
		await expect(openVolume()).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
	})

	it.each([
		{ items: {} },
		{ items: Array.from({ length: 1001 }, (_, i) => livePod(String(i))) },
		{ items: [], metadata: { continue: 1 } },
		{ items: [], metadata: { continue: 'x'.repeat(8193) } },
	])('refuses a malformed or unbounded pod list before waking', async (body) => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		podListReply = () => body
		await expect(openVolume()).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
		expect(agent?.requests).toHaveLength(0)
	})

	it('caps a paginated inventory at ten pages', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		let pages = 0
		podListReply = () => ({
			items: [],
			metadata: { continue: `page-${++pages}` },
		})
		await expect(openVolume()).rejects.toThrow()
		expect(pages).toBe(10)
		expect(sandboxPatches()).toHaveLength(0)
	})

	it.each([undefined, null, {}, { sandboxUid: SANDBOX_UID, volumeClaimUids: {} }])(
		'rejects incomplete identity %j before provider I/O',
		async (identity) => {
			await expect(
				openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
					...volumeOptions(),
					identity: identity as ReturnType<typeof volumeIdentity>,
				}),
			).rejects.toThrow()
			expect(server?.requests).toHaveLength(0)
		},
	)

	it.each([-1, 3, 6, 2_147_483_648])(
		'rejects an invalid target epoch %s before provider I/O',
		async (epoch) => {
			await expect(
				openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
					...volumeOptions(),
					epoch,
				}),
			).rejects.toThrow()
			expect(server?.requests).toHaveLength(0)
		},
	)
})

describe('reopening only a retained live closure target', () => {
	it.each([undefined, 'different-boot'])(
		'refuses a retirement reply with unproven boot %s',
		async (guestBootId) => {
			await agent!.close()
			agent = await startScriptedAgent({
				token: FIRST_POD_UID,
				guestBootId: FIRST_BOOT,
				guestBound: true,
				sessionsReply: { ok: true, sessions: [] },
				features: ['sessions'],
				retiringReply: {
					ok: false,
					error: 'agent_retiring',
					...(guestBootId ? { guestBootId } : {}),
				},
			})
			seedWorkspace({ epoch: 4 })
			agent.setLosingExecutions(true)
			const transport = new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port: agent.port,
				token: FIRST_POD_UID,
			})
			await transport.cancel('exec_2c4f6a18-9b3d-4e77-8a51-0f6d2b3c9e14')
			await expect(openClosure()).rejects.toThrow()
			expect(sandboxPatches()).toHaveLength(0)
			expect(requestsBy('DELETE')).toHaveLength(0)
		},
	)
	it('opens and stops an authenticated retired guest without trying an execution probe', async () => {
		await agent!.close()
		agent = await startScriptedAgent({
			token: FIRST_POD_UID,
			guestBootId: FIRST_BOOT,
			guestBound: true,
			sessionsReply: { ok: true, sessions: [] },
			features: ['sessions', 'flush'],
		})
		seedWorkspace({ epoch: 4 })
		await openWorkspace(4)
		agent.setLosingExecutions(true)
		const transport = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port: agent.port,
			token: FIRST_POD_UID,
		})
		expect(await transport.cancel('exec_2c4f6a18-9b3d-4e77-8a51-0f6d2b3c9e14')).toMatchObject({
			ok: false,
			error: 'cancellation_unconfirmed',
		})
		await expect(
			createKubernetesWorkspace(clusterConfig(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
				epoch: 4,
				onStartFailure: 'leave',
				refreshPodTemplate: false,
			}),
		).rejects.toThrow()
		const before = agentOperations().length
		const held = await openKubernetesWorkspaceForClosure(clusterConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			identity: closureIdentity(),
			epoch: 4,
			requireConfiguredProfile: true,
		})
		await held.suspend({
			expectedIdentity: closureIdentity(),
			epoch: 4,
			flush: { timeoutMs: 1000 },
		})
		expect(held.suspended).toBe(true)
		expect(agentOperations().slice(before)).not.toContain('execute')
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Suspended')
		expect(claimUid).toBe(CLAIM_UID)
		expect(requestsBy('DELETE')).toHaveLength(0)
	})
	it('opens with only provider and authenticated guest reads, without a privilege probe', async () => {
		seedWorkspace({ epoch: 4 })
		const held = await openClosure()
		expect(held.identity).toEqual(closureIdentity())
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		expect(server?.requests.some((request) => request.path.includes('sandboxtemplates'))).toBe(
			false,
		)
		expect(agentOperations()).toContain('list-sessions')
		expect(agentOperations()).not.toContain('execute')
		expect(agent?.requests.filter((request) => request.op !== 'healthz')).toEqual([
			{
				op: 'guest-bound',
				guestBootId: FIRST_BOOT,
				token: FIRST_POD_UID,
				request: { op: 'list-sessions' },
			},
		])
	})

	it.each([undefined, 3, 5])(
		'refuses a different stored epoch %s without writing',
		async (epoch) => {
			seedWorkspace({ epoch })
			await expect(openClosure()).rejects.toThrow()
			expect(agent?.requests).toHaveLength(0)
			expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		},
	)

	it('does not create an absent Sandbox or wake a suspended one', async () => {
		await expect(openClosure()).rejects.toThrow()
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		await expect(openClosure()).rejects.toThrow()
		expect(agent?.requests).toHaveLength(0)
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Suspended')
	})

	it.each(['sandbox', 'claim', 'claim-owner', 'missing-claim', 'pod'])(
		'refuses a replaced %s before contacting the guest',
		async (part) => {
			seedWorkspace({ epoch: 4 })
			if (part === 'sandbox') metaOf(sandboxes.get(WORKSPACE_NAME)!).uid = 'foreign'
			if (part === 'claim') claimUid = 'foreign'
			if (part === 'claim-owner') claimOwnerUid = 'foreign'
			if (part === 'missing-claim') missingClaim = true
			if (part === 'pod') livePodUid = SECOND_POD_UID
			await expect(openClosure()).rejects.toThrow()
			expect(agent?.requests).toHaveLength(0)
			expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		},
	)

	it('refuses a restarted guest in the same pod without executing or stopping it', async () => {
		seedWorkspace({ epoch: 4 })
		agent?.setGuestBootId('new-boot')
		await expect(openClosure()).rejects.toThrow()
		expect(agentOperations()).not.toContain('execute')
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('revalidates owner and disk after authenticating the guest', async () => {
		seedWorkspace({ epoch: 4 })
		let reads = 0
		beforeClaimRead = async () => {
			if (++reads === 2) claimUid = 'replaced-during-open'
		}
		await expect(openClosure()).rejects.toThrow()
		expect(agentOperations()).toContain('list-sessions')
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('rejects owner resourceVersion movement across the authenticated read', async () => {
		seedWorkspace({ epoch: 4 })
		let reads = 0
		beforePodRead = async () => {
			if (++reads === 2)
				metaOf(sandboxes.get(WORKSPACE_NAME)!).resourceVersion = nextResourceVersion()
		}
		await expect(openClosure()).rejects.toThrow()
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('cancellation during open never suspends or deletes the target', async () => {
		seedWorkspace({ epoch: 4 })
		const entered = barrier()
		const release = barrier()
		beforeClaimRead = async () => {
			entered.release()
			await release.promise
		}
		const controller = new AbortController()
		const opening = openClosure(controller.signal)
		const rejected = expect(opening).rejects.toThrow()
		await entered.promise
		controller.abort()
		release.release()
		await rejected
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Running')
	})

	it('owns its input before awaiting provider reads', async () => {
		seedWorkspace({ epoch: 4 })
		const entered = barrier()
		const release = barrier()
		beforeClaimRead = async () => {
			entered.release()
			await release.promise
		}
		const identity = closureIdentity()
		const opening = openKubernetesWorkspaceForClosure(clusterConfig(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			identity,
			epoch: 4,
		})
		await entered.promise
		identity.sandboxUid = 'caller-mutated'
		identity.volumeClaimUids.workspace = 'caller-mutated'
		release.release()
		expect((await opening).identity).toEqual(closureIdentity())
	})

	it('rejects resume, unbound stops and a different epoch without mutations', async () => {
		seedWorkspace({ epoch: 4 })
		const held = await openClosure()
		await expect(held.resume()).rejects.toThrow()
		await expect(held.suspend()).rejects.toThrow()
		await expect(held.destroy({ deleteDisk: true })).rejects.toThrow()
		await expect(
			held.suspend({
				expectedIdentity: closureIdentity(),
				epoch: 5,
				flush: false,
			}),
		).rejects.toThrow()
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('keeps direct operations pinned after a same-pod guest restart', async () => {
		seedWorkspace({ epoch: 4 })
		const held = await openClosure()
		agent?.setGuestBootId('new-boot')
		await expect(held.exec('anything')).rejects.toThrow()
		await expect(held.readFile('/workspace/file')).rejects.toThrow()
		expect(server?.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('dispatches data directly on its pinned wire without uncancellable provider reads', async () => {
		seedWorkspace({ epoch: 4 })
		const held = await openClosure()
		const providerReads = server?.requests.length
		const guestCalls = agent?.requests.length
		const controller = new AbortController()
		controller.abort()
		expect((await held.exec('never-run', [], { signal: controller.signal })).exitCode).toBe(1)
		await expect(held.readFile('/workspace/file', { signal: controller.signal })).rejects.toThrow()
		expect(agent?.requests).toHaveLength(guestCalls!)
		expect(server?.requests).toHaveLength(providerReads!)
		await held.listSessions()
		expect(server?.requests).toHaveLength(providerReads!)
		expect(agent?.requests.at(-1)).toEqual({
			op: 'guest-bound',
			guestBootId: FIRST_BOOT,
			token: FIRST_POD_UID,
			request: { op: 'list-sessions' },
		})
	})

	it.each(['suspend', 'delete'] as const)('allows only its exact bound %s', async (action) => {
		seedWorkspace({ epoch: 4 })
		const held = await openClosure()
		if (action === 'suspend')
			await held.suspend({
				expectedIdentity: closureIdentity(),
				epoch: 4,
				flush: false,
			})
		else
			await held.destroy({
				expectedIdentity: closureIdentity(),
				epoch: 4,
				flush: false,
				deleteDisk: true,
			})
		expect(held.status).toBe('destroyed')
		expect(requestsBy('POST')).toHaveLength(0)
		expect(action === 'suspend' ? sandboxPatches() : requestsBy('DELETE')).toHaveLength(1)
	})
})

describe('lifecycle bound to a captured durable owner', () => {
	it.each(['suspend', 'delete'] as const)(
		'does not automatically retry a %s conflict over a replacement pod',
		async (action) => {
			const held = await openWorkspace(4)
			const expectedIdentity = held.identity
			const replace = () => {
				beforePatch = undefined
				beforeDelete = undefined
				livePodUid = SECOND_POD_UID
				metaOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject).resourceVersion =
					nextResourceVersion()
			}
			if (action === 'suspend') beforePatch = replace
			else beforeDelete = replace
			const stop = () =>
				action === 'suspend'
					? held.suspend({ expectedIdentity, epoch: 4, flush: false })
					: held.destroy({
							expectedIdentity,
							epoch: 4,
							flush: false,
							deleteDisk: true,
						})
			await expect(stop()).rejects.toThrow()
			expect(action === 'suspend' ? sandboxPatches().length : requestsBy('DELETE').length).toBe(1)
			await expect(stop()).rejects.toThrow()
			expect(action === 'suspend' ? sandboxPatches().length : requestsBy('DELETE').length).toBe(1)
			expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
		},
	)
	it('rechecks the original guest after a rejected terminal write', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		refuseEveryJsonPatch = true
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		const count = sandboxPatches().length
		expect(count).toBe(1)
		refuseEveryJsonPatch = false
		livePodUid = SECOND_POD_UID
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(count)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
	})

	it('reconciles a landed delete with a lost reply without reopening the guest', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		afterDelete = () => {
			afterDelete = undefined
			return { status: 200, reset: true }
		}
		await expect(
			held.destroy({
				expectedIdentity,
				epoch: 4,
				deleteDisk: true,
				flush: false,
			}),
		).rejects.toThrow()
		const guestCalls = agent?.requests.length
		await held.destroy({
			expectedIdentity,
			epoch: 4,
			deleteDisk: true,
			flush: false,
		})
		expect(requestsBy('DELETE')).toHaveLength(1)
		expect(agent?.requests.length).toBe(guestCalls)
	})

	it('keeps an earlier admitted resume ahead of a later bound stop', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		const resuming = held.resume({ epoch: 5 })
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		await resuming
		expect(storedEpoch()).toBe('5')
	})

	it('captures caller identity before awaiting and refuses a stronger joining request', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = {
			...held.identity,
			volumeClaimUids: { ...held.identity.volumeClaimUids },
		}
		const original = structuredClone(expectedIdentity)
		const entered = barrier()
		const unblock = barrier()
		beforeClaimRead = async () => {
			entered.release()
			await unblock.promise
		}
		const stopping = held.suspend({ expectedIdentity, epoch: 4, flush: false })
		await entered.promise
		expectedIdentity.sandboxUid = 'caller-mutated'
		expectedIdentity.volumeClaimUids.workspace = 'caller-mutated'
		await expect(
			held.suspend({ expectedIdentity: original, epoch: 4, flush: true }),
		).rejects.toThrow()
		unblock.release()
		await stopping
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
	})
	it('refuses a replacement pod before dispatch even when flushing is disabled', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		livePodUid = SECOND_POD_UID
		const count = sandboxPatches().length
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(count)
	})

	it('does not confuse a missing claim with a deleted Sandbox during delete retry', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		conflictingDeletes = 3
		await expect(
			held.destroy({
				expectedIdentity,
				epoch: 4,
				deleteDisk: true,
				flush: false,
			}),
		).rejects.toThrow()
		expect(requestsBy('DELETE')).toHaveLength(1)
		missingClaim = true
		livePodUid = undefined
		const count = requestsBy('DELETE').length
		await expect(
			held.destroy({
				expectedIdentity,
				epoch: 4,
				deleteDisk: true,
				flush: false,
			}),
		).rejects.toThrow()
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(true)
		expect(requestsBy('DELETE')).toHaveLength(count)
	})
	it('requires an explicit epoch and a complete original identity', async () => {
		const held = await openWorkspace()
		await expect(held.suspend({ expectedIdentity: held.identity, flush: false })).rejects.toThrow()
		await expect(
			held.suspend({
				expectedIdentity: { ...held.identity, volumeClaimUids: {} },
				epoch: 4,
				flush: false,
			}),
		).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
	})

	it('sends UID, resource version and holder epoch tests in one terminal write', async () => {
		const held = await openWorkspace(4)
		const count = sandboxPatches().length
		await held.suspend({
			expectedIdentity: held.identity,
			epoch: 4,
			flush: false,
		})
		const patch = patchOperations(sandboxPatches()[count] as RecordedRequest)
		expect(patch).toEqual(
			expect.arrayContaining([
				{ op: 'test', path: '/metadata/uid', value: SANDBOX_UID },
				{
					op: 'test',
					path: '/metadata/resourceVersion',
					value: expect.any(String),
				},
				{ op: 'test', path: EPOCH_POINTER, value: '4' },
			]),
		)
	})

	it.each(['uid', 'owner'])(
		'refuses a substituted PVC %s before a terminal write',
		async (part) => {
			const held = await openWorkspace(4)
			const count = sandboxPatches().length
			if (part === 'uid') claimUid = 'different-claim'
			else claimOwnerUid = 'different-owner'
			await expect(
				held.suspend({
					expectedIdentity: held.identity,
					epoch: 4,
					flush: false,
				}),
			).rejects.toThrow()
			expect(sandboxPatches()).toHaveLength(count)
			expect(held.suspended).toBe(false)
		},
	)

	it('does not follow a same-name Sandbox replaced during a CAS retry', async () => {
		const held = await openWorkspace(4)
		const count = sandboxPatches().length
		beforePatch = () => {
			beforePatch = undefined
			const object = sandboxes.get(WORKSPACE_NAME) as SandboxObject
			metaOf(object).uid = 'replacement'
			metaOf(object).resourceVersion = nextResourceVersion()
		}
		await expect(
			held.suspend({ expectedIdentity: held.identity, epoch: 4, flush: false }),
		).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(count + 1)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
	})

	it('retains the captured owner after a landed patch loses its reply and clears the session', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		afterPatch = () => {
			afterPatch = undefined
			return { status: 200, reset: true }
		}
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		expect(held.identity.podUid).toBeUndefined()
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
		await held.suspend({ expectedIdentity, epoch: 4, flush: false })
		expect(held.suspended).toBe(true)
	})

	it('retries only retirement observation after its session has been cleared', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		afterPatch = () => {
			afterPatch = undefined
			failPodRead = true
			return undefined
		}
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		expect(held.identity.podUid).toBeUndefined()
		await held.suspend({ expectedIdentity, epoch: 4, flush: false })
		expect(held.suspended).toBe(true)
	})

	it('refuses an overtaken holder on an accepted-stop retry', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		afterPatch = () => {
			afterPatch = undefined
			failPodRead = true
			return undefined
		}
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toThrow()
		const annotations = annotationsOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)
		if (!annotations) throw new Error('missing holder annotation')
		annotations[EPOCH_KEY] = '5'
		const count = sandboxPatches().length
		await expect(held.suspend({ expectedIdentity, epoch: 4, flush: false })).rejects.toBeInstanceOf(
			KubernetesWorkspacePreconditionError,
		)
		expect(sandboxPatches()).toHaveLength(count)
	})

	it('does not rebind or stop after the guest boot changes during strict flush', async () => {
		await agent?.close()
		agent = await startScriptedAgent({
			token: FIRST_POD_UID,
			guestBootId: FIRST_BOOT,
			guestBound: true,
			sessionsReply: { ok: true, sessions: [] },
			features: ['flush', 'sessions'],
			flushReply: { ok: true },
		})
		const held = await openWorkspace(4)
		const count = sandboxPatches().length
		agent.setGuestBootId('replacement-boot')
		await expect(held.suspend({ expectedIdentity: held.identity, epoch: 4 })).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(count)
		expect(held.identity.podUid).toBe(FIRST_POD_UID)
	})

	it.each(['bound-first', 'unbound-first'])(
		'refuses mixing bound and unbound flights (%s)',
		async (order) => {
			const held = await openWorkspace(4)
			const expectedIdentity = held.identity
			const entered = barrier()
			const unblock = barrier()
			if (order === 'bound-first')
				beforeClaimRead = async () => {
					entered.release()
					await unblock.promise
				}
			else
				beforePodRead = async () => {
					entered.release()
					await unblock.promise
				}
			const first =
				order === 'bound-first'
					? held.suspend({ expectedIdentity, epoch: 4, flush: false })
					: held.suspend({ epoch: 4, flush: false })
			await entered.promise
			try {
				await expect(
					order === 'bound-first'
						? held.suspend({ epoch: 4, flush: false })
						: held.suspend({ expectedIdentity, epoch: 4, flush: false }),
				).rejects.toThrow()
			} finally {
				unblock.release()
			}
			await first
		},
	)

	it('does not report a delete complete before the original pod terminates', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		const entered = barrier()
		const unblock = barrier()
		afterDelete = () => {
			drainingGets = 1
			beforePodRead = async () => {
				entered.release()
				await unblock.promise
			}
			return undefined
		}
		let finished = false
		const deleting = held
			.destroy({ expectedIdentity, epoch: 4, deleteDisk: true, flush: false })
			.then(() => {
				finished = true
			})
		await entered.promise
		expect(finished).toBe(false)
		expect(requestsBy('DELETE')[0]?.body).toEqual({
			apiVersion: 'v1',
			kind: 'DeleteOptions',
			preconditions: { uid: SANDBOX_UID, resourceVersion: expect.any(String) },
		})
		unblock.release()
		await deleting
		expect(finished).toBe(true)
	})

	it('never deletes a recreated owner when the first delete reply was lost', async () => {
		const held = await openWorkspace(4)
		const expectedIdentity = held.identity
		afterDelete = () => {
			afterDelete = undefined
			return { status: 200, reset: true }
		}
		await expect(
			held.destroy({
				expectedIdentity,
				epoch: 4,
				deleteDisk: true,
				flush: false,
			}),
		).rejects.toThrow()
		const replacement = newSandboxObject()
		metaOf(replacement).uid = 'replacement-owner'
		sandboxes.set(WORKSPACE_NAME, replacement)
		await expect(
			held.destroy({
				expectedIdentity,
				epoch: 4,
				deleteDisk: true,
				flush: false,
			}),
		).rejects.toThrow()
		expect(requestsBy('DELETE')).toHaveLength(1)
		expect(sandboxes.get(WORKSPACE_NAME)).toBe(replacement)
	})
})

describe('a write carrying no epoch', () => {
	it('sends the requests it always sent, merge patch and all', async () => {
		// The acceptance criterion the whole feature is adoptable on. The
		// shape below is the PRE-CHANGE one: two merge patches with the
		// annotation-plus-mode body, a DELETE with no body at all, and not one
		// conditional request anywhere.
		const held = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		await held.suspend()
		await held.resume()
		await held.destroy({ deleteDisk: true })

		const patches = sandboxPatches()
		expect(patches.map((p) => p.contentType)).toEqual([MERGE_PATCH, MERGE_PATCH])
		expect(patches[0]?.body).toEqual({
			metadata: { annotations: { [MODE_CHANGED_AT]: expect.any(String) } },
			spec: { operatingMode: 'Suspended' },
		})
		expect(patches[1]?.body).toEqual({
			metadata: { annotations: { [MODE_CHANGED_AT]: expect.any(String) } },
			spec: { operatingMode: 'Running' },
		})
		const deletes = requestsBy('DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.body).toBeUndefined()
		expect(deletes[0]?.contentType).toBe('')
		// And nothing anywhere in the exchange carried an epoch.
		expect(JSON.stringify(server.requests)).not.toContain(EPOCH_KEY)
	}, 20_000)

	it('leaves a workspace another process fenced alone, because it asked nothing', async () => {
		// An unfenced write is not a write with epoch 0: it carries no
		// condition at all, so it still applies to a workspace held at 7. A
		// host opts INTO the fence, and one that has not opted in is exactly
		// where it was before this existed.
		seedWorkspace({ epoch: 7 })
		const held = await openWorkspace()
		await held.suspend()
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
		expect(storedEpoch()).toBe('7')
	}, 20_000)
})

describe('a superseded holder', () => {
	it('is refused its suspend, and the workspace goes on serving the new holder', async () => {
		// Process A opens at epoch 4. Process B takes the workspace over at 5
		// — an adopt of a RUNNING object, which before this sent nothing at
		// all and so left A nothing to be refused by.
		const a = await openWorkspace(4)
		if (!agent) throw new Error('fixtures not started')
		const b = await openWorkspace(5)
		expect(storedEpoch()).toBe('5')

		const refusal = await a.suspend().catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		const precondition = refusal as KubernetesWorkspacePreconditionError
		expect(precondition.operation).toBe('suspend')
		expect(precondition.workspaceId).toBe(WORKSPACE_ID)
		expect(precondition.sandboxName).toBe(WORKSPACE_NAME)
		expect(precondition.epoch).toBe(4)
		expect(precondition.storedEpoch).toBe(5)
		expect(precondition.message).toMatch(/another process took this workspace over/)

		// Nothing on the cluster: the mode is untouched and the pod behind it
		// is the one it was.
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
		expect(livePodUid).toBe(FIRST_POD_UID)
		// Nothing about A either — and B is still working.
		expect(a.suspended).toBe(false)
		expect((await b.exec('true')).exitCode).toBe(0)

		// And the holder that IS current suspends normally.
		await b.suspend()
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
		expect(storedEpoch()).toBe('5')
	}, 30_000)

	it('is refused its destroy, and no DELETE is sent', async () => {
		// The race that cannot be undone: a retention job in process A calls
		// destroy({ deleteDisk: true }) while a user reopens the workspace
		// through B. The DELETE cascades to the PVC.
		const a = await openWorkspace(4)
		await openWorkspace(5)

		const refusal = await a.destroy({ deleteDisk: true }).catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expect((refusal as KubernetesWorkspacePreconditionError).storedEpoch).toBe(5)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(true)
		expect(a.status).not.toBe('destroyed')
	}, 30_000)

	it('cannot create its way back in, and starts no pod doing it', async () => {
		// B suspends at 5; A opens at 4. The adopt refuses BEFORE the resume
		// patch, like every other adoption refusal, so the object stays
		// Suspended and nothing is woken on the way to being rejected.
		seedWorkspace({ epoch: 5, mode: 'Suspended' })
		const refusal = await openWorkspace(4).catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expect((refusal as KubernetesWorkspacePreconditionError).storedEpoch).toBe(5)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
		expect(sandboxPatches()).toHaveLength(0)
		expect(livePodUid).toBeUndefined()
	}, 20_000)

	it('sends no write at all when its own cancellation goes unconfirmed', async () => {
		// The unconfirmed-cancel path no longer patches ANYTHING — the
		// workspace is kept and the host is told through the callback instead
		// — so on a superseded handle there is nothing left for an epoch to
		// refuse. What this asserts is that the two changes compose: the
		// superseded handle writes nothing, and the workspace goes on running
		// under the holder that overtook it.
		const a = await openWorkspace(4)
		if (!agent) throw new Error('fixtures not started')
		const b = await openWorkspace(5)
		const patchesBefore = sandboxPatches().length

		agent.setLosingExecutions(true)
		const failure = await a.exec('sleep 30').catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(Error)
		const retirement = (failure as { retirement?: { accepted: boolean; reason?: string } })
			.retirement
		expect(retirement?.accepted).toBe(false)
		expect(retirement?.reason).toBe('workspace-kept')

		expect(sandboxPatches()).toHaveLength(patchesBefore)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
		expect(storedEpoch()).toBe('5')
		expect(b.suspended).toBe(false)
	}, 40_000)
})

describe('the patch a fenced write sends', () => {
	it('is one request carrying the test and the mutation together', async () => {
		seedWorkspace({ epoch: 2 })
		const held = await openWorkspace(2)
		const patchesBefore = sandboxPatches().length
		await held.suspend()

		const patch = sandboxPatches().at(-1)
		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		expect(patch?.contentType).toBe(JSON_PATCH)
		expect(patchOperations(patch as RecordedRequest)).toEqual([
			{ op: 'test', path: EPOCH_POINTER, value: '2' },
			{ op: 'add', path: EPOCH_POINTER, value: '2' },
			{
				op: 'add',
				path: '/metadata/annotations/sandbox.namzu.ai~1operating-mode-changed-at',
				value: expect.any(String),
			},
			{ op: 'add', path: '/spec/operatingMode', value: 'Suspended' },
		])
		// Every `test` precedes every mutation, which is what makes the
		// condition a condition rather than a check of this patch's own work.
		const ops = patchOperations(patch as RecordedRequest)
		expect(ops.findIndex((o) => o.op === 'test')).toBeLessThan(ops.findIndex((o) => o.op === 'add'))
	}, 20_000)

	it('adds the annotation map whole when the object carries none', async () => {
		// An object an older release created: no annotations at all, so there
		// is no member to add one to and the condition has to fall back to
		// resourceVersion. It is SEEDED rather than created here, because a
		// create made by this release always stamps at least the pod-template
		// revision — which is exactly what makes this the migration case and
		// not the steady state.
		seedWorkspace()
		const object = sandboxes.get(WORKSPACE_NAME) as SandboxObject
		expect(annotationsOf(object)).toBeUndefined()
		const version = metaOf(object).resourceVersion
		const held = await openWorkspace()

		await held.suspend({ epoch: 3 })
		const patch = sandboxPatches().at(-1)
		expect(patch?.contentType).toBe(JSON_PATCH)
		const ops = patchOperations(patch as RecordedRequest)
		expect(ops[0]).toEqual({
			op: 'test',
			path: '/metadata/resourceVersion',
			value: version,
		})
		expect(ops[1]).toEqual({
			op: 'add',
			path: '/metadata/annotations',
			value: { [EPOCH_KEY]: '3', [MODE_CHANGED_AT]: expect.any(String) },
		})
		expect(storedEpoch()).toBe('3')
	}, 20_000)

	it('adds the member when the object carries other annotations but not this one', async () => {
		sandboxes.set(WORKSPACE_NAME, newSandboxObject({ annotations: { 'example.com/owner': 'ops' } }))
		const held = await openWorkspace()
		const version = metaOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject).resourceVersion

		await held.suspend({ epoch: 3 })
		const ops = patchOperations(sandboxPatches().at(-1) as RecordedRequest)
		expect(ops[0]).toEqual({
			op: 'test',
			path: '/metadata/resourceVersion',
			value: version,
		})
		expect(ops[1]).toEqual({ op: 'add', path: EPOCH_POINTER, value: '3' })
		// And the annotation somebody else put there is still standing.
		expect(annotationsOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toEqual({
			'example.com/owner': 'ops',
			[EPOCH_KEY]: '3',
			[MODE_CHANGED_AT]: expect.any(String),
		})
	}, 20_000)

	it('succeeds after exactly one re-read when a controller moves resourceVersion — the MIGRATION path only', async () => {
		// Named for what it covers and no more. This is the path where the
		// condition IS `resourceVersion`, which only happens on an object that
		// carries no epoch annotation yet; once one has landed, the condition
		// is the annotation and a controller status write moves nothing the
		// patch is testing. Keeping this test is not the same as believing it
		// covers steady state.
		const held = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		const before = server.requests.length
		bumpBeforeNextPatch = true

		await held.suspend({ epoch: 1 })

		const after = server.requests.slice(before)
		const sandboxCalls = after.filter((r) => r.path.includes(`/sandboxes/${WORKSPACE_NAME}`))
		// GET (the gate), PATCH (refused), GET (the one re-read), PATCH (applied).
		expect(sandboxCalls.map((r) => r.method)).toEqual(['GET', 'PATCH', 'GET', 'PATCH'])
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
		expect(storedEpoch()).toBe('1')
	}, 20_000)

	it('does not retry a patch the object did not move under', async () => {
		// The discrimination the API server refuses to make for anyone: an
		// unapplied patch answers 422 whether a `test` failed or the body was
		// wrong. So the host re-reads, and a value that has not moved means
		// the patch is wrong rather than late — one re-read, then the error
		// stands, instead of spinning until the attempt budget runs out.
		const held = await openWorkspace(1)
		if (!server) throw new Error('fixtures not started')
		const before = server.requests.length
		refuseEveryJsonPatch = true

		const failure = await held.suspend().catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(Error)
		expect((failure as Error).name).toBe('KubernetesPatchNotAppliedError')
		const sent = server.requests
			.slice(before)
			.filter((r) => r.path.includes(`/sandboxes/${WORKSPACE_NAME}`))
		// The gate's GET, one PATCH, and one re-read that found nothing moved.
		expect(sent.map((r) => r.method)).toEqual(['GET', 'PATCH', 'GET'])
		// And the handle is put back exactly where it was: a patch that did
		// not apply did not suspend anything.
		expect(held.suspended).toBe(false)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
	}, 20_000)
})

describe('taking a workspace over', () => {
	it('stamps the epoch on an adopt of a workspace that is already Running', async () => {
		await openWorkspace()
		expect(storedEpoch()).toBeUndefined()
		const patchesBefore = sandboxPatches().length

		await openWorkspace(9)
		const patch = sandboxPatches().at(-1)
		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		expect(patch?.contentType).toBe(JSON_PATCH)
		// The mode is not touched — and neither is the annotation that says
		// when the mode last changed, because it did not.
		const ops = patchOperations(patch as RecordedRequest)
		expect(ops.some((o) => o.path === '/spec/operatingMode')).toBe(false)
		expect(ops.some((o) => o.path.includes('operating-mode-changed-at'))).toBe(false)
		expect(storedEpoch()).toBe('9')
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
	}, 20_000)

	it('stamps the epoch when resume() is called on a workspace that is already running', async () => {
		const held = await openWorkspace(2)
		const patchesBefore = sandboxPatches().length
		await held.resume({ epoch: 6 })
		expect(sandboxPatches()).toHaveLength(patchesBefore + 1)
		expect(storedEpoch()).toBe('6')
		// And the handle now writes under the epoch it was resumed with.
		await held.suspend()
		const ops = patchOperations(sandboxPatches().at(-1) as RecordedRequest)
		expect(ops[0]).toEqual({ op: 'test', path: EPOCH_POINTER, value: '6' })
	}, 20_000)

	it('stamps the POST, so a created workspace is fenced before it is running', async () => {
		await openWorkspace(4)
		const post = requestsBy('POST').at(0)
		expect((post?.body as { metadata?: { annotations?: unknown } })?.metadata?.annotations).toEqual(
			{
				[EPOCH_KEY]: '4',
				// The create body also records the pod template it was built
				// from, which a workspace carries from the moment it exists
				// for the same reason the epoch does — see
				// `workspace-template-refresh.test.ts`.
				'sandbox.namzu.ai/pod-template-hash': expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			},
		)
		expect(storedEpoch()).toBe('4')
	}, 20_000)
})

describe('the standalone verbs', () => {
	it('refuses a stale suspendKubernetesWorkspace and writes nothing', async () => {
		seedWorkspace({ epoch: 5 })
		const refusal = await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID, {
			epoch: 4,
		}).catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expect((refusal as KubernetesWorkspacePreconditionError).operation).toBe(
			'suspendKubernetesWorkspace',
		)
		expect((refusal as KubernetesWorkspacePreconditionError).storedEpoch).toBe(5)
		expect(sandboxPatches()).toHaveLength(0)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Running')
	})

	it('refuses a stale deleteKubernetesWorkspace and sends no DELETE', async () => {
		seedWorkspace({ epoch: 5 })
		const refusal = await deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID, {
			epoch: 4,
		}).catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		expect((refusal as KubernetesWorkspacePreconditionError).operation).toBe(
			'deleteKubernetesWorkspace',
		)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(true)
	})

	it('sends a current deleteKubernetesWorkspace under a resourceVersion precondition', async () => {
		seedWorkspace({ epoch: 5 })
		const version = metaOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject).resourceVersion
		await deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID, {
			epoch: 5,
		})
		const sent = requestsBy('DELETE')
		expect(sent).toHaveLength(1)
		expect(sent[0]?.body).toEqual({
			apiVersion: 'v1',
			kind: 'DeleteOptions',
			preconditions: { resourceVersion: version },
		})
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
	})

	it('resolves a fenced destroy of a workspace somebody already deleted', async () => {
		// Already gone is the state DELETE was asking for, and an unfenced
		// destroy has always resolved on it. Reading the epoch first must not
		// turn that into a rejection: the fence exists to stop a write, and
		// there is no write left to stop.
		const held = await openWorkspace(4)
		sandboxes.delete(WORKSPACE_NAME)
		livePodUid = undefined
		await held.destroy({ deleteDisk: true })
		expect(held.status).toBe('destroyed')
		expect(requestsBy('DELETE')).toHaveLength(0)
	}, 20_000)

	it('re-reads and retries a DELETE the API server refused on its precondition', async () => {
		seedWorkspace({ epoch: 5 })
		conflictingDeletes = 1
		await deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID, {
			epoch: 5,
		})
		expect(requestsBy('DELETE')).toHaveLength(2)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
	})

	it('reports each stored epoch from a list, and writes nothing', async () => {
		seedWorkspace({ epoch: 5 })
		const summaries = await listKubernetesWorkspaces(clusterConfig(), {
			epoch: 4,
		})
		expect(summaries).toHaveLength(1)
		expect(summaries[0]?.holderEpoch).toBe(5)
		// A list sends no write, so an epoch has nothing to condition here and
		// is not read — what an inventory needs is to SEE the fences, which is
		// what `holderEpoch` above is. The assertion that matters is that no
		// write left the process either way.
		expect(sandboxPatches()).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(requestsBy('POST')).toHaveLength(0)
	})

	it('reports epoch 0 for a workspace nobody has fenced', async () => {
		seedWorkspace()
		const summaries = await listKubernetesWorkspaces(clusterConfig())
		expect(summaries[0]?.holderEpoch).toBe(0)
	})
})

describe('an epoch this backend cannot honour', () => {
	it('refuses a fractional or negative one at the call, before anything is read', async () => {
		if (!server) throw new Error('fixtures not started')
		await expect(openWorkspace(1.5)).rejects.toThrow(/non-negative safe integer/)
		await expect(openWorkspace(-1)).rejects.toThrow(/non-negative safe integer/)
		expect(server.requests).toHaveLength(0)
	})

	it('refuses to write over a stored annotation that is not a decimal integer', async () => {
		// Nothing this backend writes produces one, so it was set by hand or
		// by something else — and reading it as 0 would let this write
		// overwrite a fence it does not understand.
		sandboxes.set(WORKSPACE_NAME, newSandboxObject({ annotations: { [EPOCH_KEY]: 'latest' } }))
		const refusal = await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID, {
			epoch: 9,
		}).catch((err: unknown) => err)
		expect(refusal).toBeInstanceOf(KubernetesWorkspacePreconditionError)
		const precondition = refusal as KubernetesWorkspacePreconditionError
		expect(precondition.storedEpoch).toBeUndefined()
		expect(precondition.storedAnnotation).toBe('latest')
		expect(precondition.message).toMatch(/not a decimal integer/)
		expect(sandboxPatches()).toHaveLength(0)
	})

	it('omits holderEpoch from a list entry it could not read, rather than reporting 0', async () => {
		sandboxes.set(WORKSPACE_NAME, newSandboxObject({ annotations: { [EPOCH_KEY]: 'latest' } }))
		const summaries = await listKubernetesWorkspaces(clusterConfig())
		expect(summaries[0]?.holderEpoch).toBeUndefined()
	})
})

/**
 * The one invariant a scripted peer cannot carry: a refused `suspend()`
 * leaves the handle's TERMINALS open.
 *
 * `suspendNow` SIGKILLs every terminal this handle handed out and waits for
 * each to exit, all of it before any request goes out — so a superseded
 * holder that learned it was superseded FROM the write would already have
 * taken its own caller's interactive sessions away over a write that never
 * applied. That is the whole reason the epoch is read in a gate of its own
 * rather than left to the patch's `test` clause.
 *
 * Proving it needs a real terminal, so this block runs the REAL
 * `agent/agent.cjs` on a loopback socket underneath the same fake API server
 * — the same arrangement `execution-attach.test.ts` uses, including its `cat`
 * shim, because `createKubernetesWorkspace` gates on a privilege probe that
 * runs `cat /proc/self/status` in the guest and the test host's own node
 * process is correctly not deprivileged.
 */
describe('a refused suspend does not reap the terminals it never suspended', () => {
	const require_ = createRequire(import.meta.url)
	const AGENT_PATH = '../../../../agent/agent.cjs'

	interface AgentModule {
		handleConnection(socket: Socket): void
	}

	let workDir: string
	let shimDir: string
	let listener: Server | undefined
	let accepted: Socket[]
	let realAgentPort: number
	let savedEnv: Record<string, string | undefined>
	let savedPath: string | undefined

	beforeEach(async () => {
		savedEnv = Object.fromEntries(AGENT_ENV_KEYS.map((key) => [key, process.env[key]]))
		savedPath = process.env.PATH
		workDir = mkdtempSync(join(tmpdir(), 'namzu-epoch-'))
		shimDir = mkdtempSync(join(tmpdir(), 'namzu-epoch-shim-'))
		writeFileSync(
			join(shimDir, 'cat'),
			`#!/bin/sh\nprintf '%s' '${DEPRIVILEGED_PROC_STATUS.replace(/'/g, "'\\''")}'\n`,
		)
		chmodSync(join(shimDir, 'cat'), 0o755)
		process.env.PATH = `${shimDir}:${savedPath ?? ''}`
		for (const key of AGENT_ENV_KEYS) delete process.env[key]
		process.env.NAMZU_AGENT_BIND_TOKEN = FIRST_POD_UID
		process.env.NAMZU_SANDBOX_WORKSPACE = workDir
		delete require_.cache[require_.resolve(AGENT_PATH)]
		const realAgent = require_(AGENT_PATH) as AgentModule
		accepted = []
		listener = createServer((socket) => {
			accepted.push(socket)
			realAgent.handleConnection(socket)
		})
		await new Promise<void>((resolve, reject) => {
			listener?.once('error', reject)
			listener?.listen(0, '127.0.0.1', () => resolve())
		})
		realAgentPort = (listener.address() as AddressInfo).port
	})

	afterEach(async () => {
		for (const socket of accepted) socket.destroy()
		accepted = []
		if (listener) {
			listener.close()
			await once(listener, 'close').catch(() => undefined)
		}
		listener = undefined
		for (const key of AGENT_ENV_KEYS) delete process.env[key]
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value !== undefined) process.env[key] = value
		}
		if (savedPath !== undefined) process.env.PATH = savedPath
		rmSync(workDir, { recursive: true, force: true })
		rmSync(shimDir, { recursive: true, force: true })
	})

	async function openAgainstRealAgent(epoch: number) {
		return await createKubernetesWorkspace(
			{ ...clusterConfig(), agentPort: realAgentPort },
			{ workspaceId: WORKSPACE_ID, workingDirectory: workDir, epoch },
		)
	}

	it('verifies a bound stop against the real agent with its default read roots', async () => {
		const held = await openAgainstRealAgent(4)
		const expectedIdentity = held.identity
		await held.suspend({ expectedIdentity, epoch: 4, flush: false })
		expect(held.suspended).toBe(true)
		expect(modeOf(sandboxes.get(WORKSPACE_NAME) as SandboxObject)).toBe('Suspended')
	})

	it.skipIf(process.platform !== 'linux')(
		'leaves an open terminal running',
		async () => {
			const a = await openAgainstRealAgent(4)
			const terminal = await a.openTerminal({ size: { cols: 80, rows: 24 } })
			let exited = false
			void terminal.exited.then(
				() => {
					exited = true
				},
				() => {
					exited = true
				},
			)

			// Process B takes the workspace over at 5. The pod does not change —
			// nothing about this adopt touches the pod — so A's terminal is still
			// attached to a live guest when A tries to suspend.
			await openAgainstRealAgent(5)

			await expect(a.suspend()).rejects.toBeInstanceOf(KubernetesWorkspacePreconditionError)
			await new Promise((resolve) => setTimeout(resolve, 200))
			expect(exited).toBe(false)
			expect(a.suspended).toBe(false)

			terminal.kill('SIGKILL')
			await terminal.exited.catch(() => undefined)
		},
		40_000,
	)
})

describe('retained volume execution profile admission', () => {
	it('refuses a different template before waking the exact retained volume', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		await expect(
			openKubernetesWorkspaceVolumeForClosure(
				{ ...clusterConfig(), sandboxTemplateName: 'native-documents' },
				{ ...volumeOptions(), requireConfiguredProfile: true },
			),
		).rejects.toMatchObject({ field: 'sandboxTemplateName' })
		expect(sandboxPatches()).toHaveLength(0)
		expect(agentOperations()).toHaveLength(0)
	})
	it('accepts a matching template through wake and live guest admission', async () => {
		seedWorkspace({ epoch: 4, mode: 'Suspended' })
		const held = await openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
			...volumeOptions(),
			requireConfiguredProfile: true,
		})
		expect(held.identity.sandboxUid).toBe(SANDBOX_UID)
		expect(sandboxPatches()).toHaveLength(1)
	})
	it('refuses a mismatched live guest profile before issuing guest operations', async () => {
		seedWorkspace({ epoch: 4 })
		await expect(
			openKubernetesWorkspaceForClosure(
				{ ...clusterConfig(), sandboxTemplateName: 'native-documents' },
				{
					workspaceId: WORKSPACE_ID,
					workingDirectory: '/workspace',
					identity: closureIdentity(),
					epoch: 4,
					requireConfiguredProfile: true,
				},
			),
		).rejects.toMatchObject({ field: 'sandboxTemplateName' })
		expect(sandboxPatches()).toHaveLength(0)
		expect(agentOperations()).toHaveLength(0)
	})
})

// The annotation names are deliberately literal: a public provider receipt
// must continue to mean the same thing across releases and host restarts.
const ALLOCATION_ID = 'sandbox.namzu.ai/allocation-id'
const ALLOCATION_SCOPE = 'sandbox.namzu.ai/allocation-scope'
const originalAllocation = () => ({
	id: 'original-opening-attempt',
	scopeFingerprint: 'a'.repeat(64),
})
const allocationOptions = () => ({
	workspaceId: WORKSPACE_ID,
	epoch: 4,
	allocation: originalAllocation(),
})
function seedAllocation(mode: 'Running' | 'Suspended' = 'Running') {
	seedWorkspace({ epoch: 4, mode })
	const object = sandboxes.get(WORKSPACE_NAME)!
	metaOf(object).annotations = {
		...annotationsOf(object),
		[ALLOCATION_ID]: originalAllocation().id,
		[ALLOCATION_SCOPE]: originalAllocation().scopeFingerprint,
	}
}

describe('original creation-only allocation', () => {
	for (const action of ['suspend', 'delete'] as const) {
		for (const change of ['marker', 'profile'] as const) {
			it(`refuses ${action} before any terminal write when ${change} changes during a held flush`, async () => {
				seedAllocation()
				const entered = barrier()
				const release = barrier()
				await agent?.close()
				agent = await startScriptedAgent({
					token: FIRST_POD_UID,
					guestBootId: FIRST_BOOT,
					guestBound: true,
					features: ['sessions', 'flush'],
					sessionsReply: { ok: true, sessions: [] },
					flushReply: { ok: true, guestBootId: FIRST_BOOT, durationMs: 1, workspace: '/workspace' },
					beforeFlush: async () => {
						entered.release()
						await release.promise
					},
				})
				const held = await openKubernetesWorkspaceForClosure(clusterConfig(), {
					workspaceId: WORKSPACE_ID,
					workingDirectory: '/workspace',
					epoch: 4,
					identity: closureIdentity(),
					expectedAllocation: originalAllocation(),
					requireConfiguredProfile: true,
				})
				const options = { expectedIdentity: closureIdentity(), epoch: 4 }
				const stopping = (
					action === 'suspend'
						? held.suspend(options)
						: held.destroy({ ...options, deleteDisk: true })
				).catch((error: unknown) => error)
				await entered.promise
				const object = sandboxes.get(WORKSPACE_NAME)!
				if (change === 'marker') annotationsOf(object)![ALLOCATION_ID] = 'different-opening'
				else {
					const spec = object.spec as {
						podTemplate: { metadata: { labels: Record<string, string> } }
					}
					spec.podTemplate.metadata.labels[TEMPLATE_LABEL] = 'different-profile'
				}
				metaOf(object).resourceVersion = nextResourceVersion()
				release.release()
				expect(await stopping).toBeInstanceOf(Error)
				expect(sandboxPatches()).toHaveLength(0)
				expect(requestsBy('DELETE')).toHaveLength(0)
				expect(modeOf(object)).toBe('Running')
			})
		}
	}
	it('stamps original scope in its single POST and never opens or probes a guest', async () => {
		const receipt = await allocateKubernetesWorkspace(clusterConfig(), allocationOptions())
		expect(receipt).toEqual({
			...allocationOptions(),
			sandboxUid: SANDBOX_UID,
		})
		expect(annotationsOf(sandboxes.get(WORKSPACE_NAME)!)).toMatchObject({
			[ALLOCATION_ID]: 'original-opening-attempt',
			[ALLOCATION_SCOPE]: 'a'.repeat(64),
			[EPOCH_KEY]: '4',
		})
		expect(requestsBy('POST')).toHaveLength(1)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agentOperations()).toEqual([])
	})

	it('lets only one competing create succeed and refuses even a matching existing marker', async () => {
		const results = await Promise.allSettled([
			allocateKubernetesWorkspace(clusterConfig(), allocationOptions()),
			allocateKubernetesWorkspace(clusterConfig(), allocationOptions()),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const refused = results.find((result) => result.status === 'rejected')
		expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(
			KubernetesWorkspaceAllocationConflictError,
		)
		expect(requestsBy('POST')).toHaveLength(2)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agentOperations()).toEqual([])
	})

	it('recovers a lost create acknowledgement through provider reads without recreating or waking', async () => {
		afterCreate = () => ({ status: 0, reset: true })
		await expect(
			allocateKubernetesWorkspace(clusterConfig(), allocationOptions()),
		).rejects.toThrow()
		const before = requestsBy('POST').length
		const observed = await inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
			epoch: 4,
			expectedAllocation: originalAllocation(),
			requireConfiguredProfile: true,
		})
		expect(observed).toEqual({
			identity: volumeIdentity(),
			epoch: 4,
			mode: 'Running',
		})
		expect(requestsBy('POST')).toHaveLength(before)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agentOperations()).toEqual([])
	})

	it.each(['id', 'scopeFingerprint'] as const)(
		'refuses a different original %s before wake or guest contact',
		async (key) => {
			seedAllocation('Suspended')
			const wrong = {
				...originalAllocation(),
				[key]: key === 'id' ? 'different-attempt' : 'b'.repeat(64),
			}
			await expect(
				inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
					epoch: 4,
					expectedAllocation: wrong,
				}),
			).rejects.toBeInstanceOf(KubernetesWorkspaceAllocationConflictError)
			await expect(
				openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
					...volumeOptions(),
					expectedAllocation: wrong,
				}),
			).rejects.toBeInstanceOf(KubernetesWorkspaceAllocationConflictError)
			expect(requestsBy('PATCH')).toHaveLength(0)
			expect(requestsBy('POST')).toHaveLength(0)
			expect(agentOperations()).toEqual([])
		},
	)

	it('rechecks original annotations at the final owner confirmation', async () => {
		seedAllocation('Suspended')
		beforeClaimRead = async () => {
			annotationsOf(sandboxes.get(WORKSPACE_NAME)!)![ALLOCATION_ID] = 'changed-during-observation'
		}
		await expect(
			openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
				...volumeOptions(),
				expectedAllocation: originalAllocation(),
			}),
		).rejects.toBeInstanceOf(KubernetesWorkspaceAllocationConflictError)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(agentOperations()).toEqual([])
	})

	it('captures allocation inputs before the first asynchronous provider operation', async () => {
		const arrived = barrier()
		const held = barrier()
		const config = {
			...clusterConfig(),
			access: {
				server: server!.url,
				getToken: async () => {
					arrived.release()
					await held.promise
					return 'sa-token'
				},
			},
		}
		const input = allocationOptions()
		const pending = allocateKubernetesWorkspace(config, input)
		await arrived.promise
		input.allocation.id = 'caller-mutation'
		input.allocation.scopeFingerprint = 'b'.repeat(64)
		input.workspaceId = 'different-workspace'
		input.epoch = 99
		held.release()
		expect(await pending).toEqual({
			workspaceId: WORKSPACE_ID,
			epoch: 4,
			allocation: originalAllocation(),
			sandboxUid: SANDBOX_UID,
		})
	})

	it('captures expected provenance before inspection waits on provider reads', async () => {
		seedAllocation()
		const arrived = barrier()
		const held = barrier()
		beforeClaimRead = async () => {
			arrived.release()
			await held.promise
		}
		const allocation = originalAllocation()
		const pending = inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
			epoch: 4,
			expectedAllocation: allocation,
		})
		await arrived.promise
		allocation.id = 'mutated-expectation'
		allocation.scopeFingerprint = 'b'.repeat(64)
		held.release()
		expect((await pending).identity).toEqual(volumeIdentity())
	})

	it('leaves missing and not-yet-ready allocations unknown without creating a replacement', async () => {
		await expect(
			inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
				epoch: 4,
				expectedAllocation: originalAllocation(),
			}),
		).rejects.toThrow()
		seedAllocation()
		missingClaim = true
		await expect(
			inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
				epoch: 4,
				expectedAllocation: originalAllocation(),
			}),
		).rejects.toThrow()
		expect(requestsBy('POST')).toHaveLength(0)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agentOperations()).toEqual([])
	})

	it('opens a matching allocation at the same recorded epoch without a wake or execution probe', async () => {
		seedAllocation()
		const held = await openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
			...volumeOptions(),
			epoch: 4,
			expectedAllocation: originalAllocation(),
			requireConfiguredProfile: true,
		})
		expect(held.identity).toEqual(closureIdentity())
		expect(requestsBy('POST')).toHaveLength(0)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(agentOperations()).toContain('list-sessions')
		expect(agentOperations().every((op) => op === 'healthz' || op === 'list-sessions')).toBe(true)
	})

	it('rechecks provenance while the final pinned handle authenticates its owner', async () => {
		seedAllocation()
		beforePodRead = async () => {
			annotationsOf(sandboxes.get(WORKSPACE_NAME)!)![ALLOCATION_ID] = 'changed-at-final-open'
		}
		await expect(
			openKubernetesWorkspaceVolumeForClosure(clusterConfig(), {
				...volumeOptions(),
				epoch: 4,
				expectedAllocation: originalAllocation(),
			}),
		).rejects.toBeInstanceOf(KubernetesWorkspaceAllocationConflictError)
		expect(requestsBy('POST')).toHaveLength(0)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(agentOperations()).toEqual(['healthz', 'list-sessions'])
	})

	it('validates explicit allocation and recovery provenance before provider requests', async () => {
		for (const bad of [
			null,
			{ id: '', scopeFingerprint: 'a'.repeat(64) },
			{ id: 'ok', scopeFingerprint: 'invalid' },
		]) {
			await expect(
				allocateKubernetesWorkspace(clusterConfig(), {
					...allocationOptions(),
					allocation: bad as never,
				}),
			).rejects.toThrow()
			await expect(
				inspectKubernetesWorkspaceVolume(clusterConfig(), WORKSPACE_ID, {
					epoch: 4,
					expectedAllocation: bad as never,
				}),
			).rejects.toThrow()
		}
		expect(server!.requests).toHaveLength(0)
	})
})

function nativeProfileConfig(): KubernetesBackendConfig {
	return {
		...clusterConfig(),
		runtimeClassName: 'kata-vm-isolation',
		ingress: { engine: 'core' },
		egress: {
			engine: 'core',
			policy: { kind: 'no-network' },
			networkPolicyName: 'native-no-network',
		},
	}
}
function installNativeTemplate() {
	nativeTemplate = structuredClone(TEMPLATE)
	Object.assign(nativeTemplate.spec.volumeClaimTemplates[0]!.spec, { storageClassName: 'zrs' })
	Object.assign(nativeTemplate.spec.podTemplate.spec, { runtimeClassName: 'kata-vm-isolation' })
	nativeTemplate.spec.podTemplate.spec.containers[0]!.image = `image@sha256:${'a'.repeat(64)}`
	nativePolicy = 'closed'
}
async function allocateNativeProfile() {
	const config = nativeProfileConfig()
	const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(config)
	const allocation = { ...originalAllocation(), executionProfile }
	await allocateKubernetesWorkspace(config, { ...allocationOptions(), allocation })
	return { config, allocation }
}

describe('resolved original native execution profile', () => {
	beforeEach(async () => {
		installNativeTemplate()
		await agent!.close()
		agent = await startScriptedAgent({
			token: FIRST_POD_UID,
			guestBootId: FIRST_BOOT,
			guestBound: true,
			features: ['sessions', 'flush'],
			sessionsReply: { ok: true, sessions: [] },
			flushReply: { ok: true, guestBootId: FIRST_BOOT, durationMs: 1, workspace: '/workspace' },
		})
	})
	it('qualifies without allocation and refuses a same-name image change before POST', async () => {
		const config = nativeProfileConfig()
		const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(config)
		expect(requestsBy('POST')).toHaveLength(0)
		expect(agentOperations()).toHaveLength(0)
		nativeTemplate!.spec.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
		await expect(
			allocateKubernetesWorkspace(config, {
				...allocationOptions(),
				allocation: { ...originalAllocation(), executionProfile },
			}),
		).rejects.toThrow()
		expect(requestsBy('POST')).toHaveLength(0)
		expect(sandboxes.size).toBe(0)
	})
	it.each(['verify', 'profile', 'profileLabelKey'] as const)(
		'rejects native %s downgrade before qualification or allocation I/O',
		async (option) => {
			const config = nativeProfileConfig()
			const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(config)
			const unqualified = {
				...config,
				egress: {
					...config.egress!,
					[option]: option === 'verify' ? 'named-object-only' : 'profile',
				},
			}
			nativePolicy = 'additional'
			const offset = server!.requests.length
			await expect(resolveKubernetesWorkspaceExecutionProfile(unqualified)).rejects.toThrow()
			await expect(
				allocateKubernetesWorkspace(unqualified, {
					...allocationOptions(),
					allocation: { ...originalAllocation(), executionProfile },
				}),
			).rejects.toThrow()
			expect(server!.requests).toHaveLength(offset)
			expect(requestsBy('POST')).toHaveLength(0)
		},
	)
	it.each(['egress', 'ingress', 'unread'] as const)(
		'refuses %s Cilium policy on fresh qualification and original reopening',
		async (policy) => {
			const config = nativeProfileConfig()
			const combined = {
				...config,
				ingress: { engine: 'cilium' as const },
				egress: { ...config.egress!, engine: 'cilium' as const },
			}
			const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(combined)
			expect(executionProfile.networkVerificationEngine).toBe('cilium')
			const allocation = { ...originalAllocation(), executionProfile }
			await allocateKubernetesWorkspace(combined, { ...allocationOptions(), allocation })
			;(sandboxes.get(WORKSPACE_NAME)!.spec as { operatingMode: string }).operatingMode =
				'Suspended'
			livePodUid = undefined
			nativeCiliumPolicy = policy
			await expect(resolveKubernetesWorkspaceExecutionProfile(combined)).rejects.toThrow()
			await expect(
				openKubernetesWorkspaceVolumeForClosure(config, {
					...volumeOptions(),
					expectedAllocation: allocation,
				}),
			).rejects.toThrow()
			expect(sandboxPatches()).toHaveLength(0)
			expect(agentOperations()).toHaveLength(0)
		},
	)
	it('refuses a profile-marked resource when original allocation authority omits its descriptor', async () => {
		const { config } = await allocateNativeProfile()
		await expect(
			inspectKubernetesWorkspaceVolume(config, WORKSPACE_ID, {
				epoch: 4,
				expectedAllocation: originalAllocation(),
			}),
		).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
		expect(agentOperations()).toHaveLength(0)
	})
	it.each(['egress', 'ingress'] as const)(
		'checks controller-added live Pod labels against Cilium %s before guest contact',
		async (policy) => {
			const base = nativeProfileConfig()
			const config = {
				...base,
				egress: { ...base.egress!, engine: 'cilium' as const },
				ingress: { engine: 'cilium' as const },
			}
			const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(config)
			const allocation = { ...originalAllocation(), executionProfile }
			await allocateKubernetesWorkspace(config, { ...allocationOptions(), allocation })
			;(sandboxes.get(WORKSPACE_NAME)!.spec as { operatingMode: string }).operatingMode =
				'Suspended'
			livePodUid = undefined
			nativeCiliumPolicy = policy
			nativeCiliumSelector = { 'controller-label': 'injected' }
			nativePodLabels = { 'controller-label': 'injected' }
			await expect(
				openKubernetesWorkspaceVolumeForClosure(config, {
					...volumeOptions(),
					expectedAllocation: allocation,
				}),
			).rejects.toThrow()
			expect(sandboxPatches()).toHaveLength(1)
			expect(agentOperations()).toHaveLength(0)
		},
	)
	it('POSTs exactly the qualified captured content even when the template changes after its read', async () => {
		const config = nativeProfileConfig()
		const executionProfile = await resolveKubernetesWorkspaceExecutionProfile(config)
		beforeNativeCreate = () => {
			nativeTemplate!.spec.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
		}
		const receipt = await allocateKubernetesWorkspace(config, {
			...allocationOptions(),
			allocation: { ...originalAllocation(), executionProfile },
		})
		expect(receipt.allocation.executionProfile).toEqual(executionProfile)
		const post = requestsBy('POST')[0]!.body as {
			spec: { podTemplate: { spec: { containers: { image: string }[] } } }
			metadata: { annotations: Record<string, string> }
		}
		expect(post.spec.podTemplate.spec.containers[0]!.image).toBe(`image@sha256:${'a'.repeat(64)}`)
		expect(post.metadata.annotations['sandbox.namzu.ai/allocation-profile']).toBe(
			executionProfile.fingerprint,
		)
	})
	it('inspects and retires original content with fresh credentials despite changed current template and port', async () => {
		const { config, allocation } = await allocateNativeProfile()
		const changed = {
			...config,
			sandboxTemplateName: 'new-template',
			runtimeClassName: 'runc',
			agentPort: 1,
			ingress: 'unverified' as const,
			egress: undefined,
		}
		nativeTemplate!.spec.podTemplate.spec.containers[0]!.image = 'unqualified:latest'
		nativePolicy = 'missing'
		const offset = server!.requests.length
		expect(
			(
				await inspectKubernetesWorkspaceVolume(changed, WORKSPACE_ID, {
					epoch: 4,
					expectedAllocation: allocation,
				})
			).identity,
		).toEqual(volumeIdentity())
		const held = await openKubernetesWorkspaceForClosure(changed, {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
			identity: closureIdentity(),
			epoch: 4,
			expectedAllocation: allocation,
		})
		await held.suspend({ expectedIdentity: closureIdentity(), epoch: 4 })
		expect(modeOf(sandboxes.get(WORKSPACE_NAME)!)).toBe('Suspended')
		expect(
			server!.requests
				.slice(offset)
				.some(
					(req) => req.path.includes('sandboxtemplates') || req.path.includes('networkpolicies'),
				),
		).toBe(false)
	})
	it('reopens the retained original copy after a current-template rollout without reading that template', async () => {
		const { config, allocation } = await allocateNativeProfile()
		const object = sandboxes.get(WORKSPACE_NAME)!
		;(object.spec as { operatingMode: string }).operatingMode = 'Suspended'
		livePodUid = undefined
		nativeTemplate!.spec.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
		const offset = server!.requests.length
		const held = await openKubernetesWorkspaceVolumeForClosure(
			{ ...config, sandboxTemplateName: 'next-template', agentPort: 1 },
			{ ...volumeOptions(), expectedAllocation: allocation },
		)
		expect(held.identity).toMatchObject({ ...volumeIdentity(), podUid: SECOND_POD_UID })
		expect(
			server!.requests.slice(offset).some((req) => req.path.includes('sandboxtemplates')),
		).toBe(false)
		expect(sandboxPatches()).toHaveLength(1)
	})
	it.each(['missing', 'wide', 'additional'] as const)(
		'refuses renewed admission under %s policy before wake or guest I/O',
		async (policy) => {
			const { config, allocation } = await allocateNativeProfile()
			;(sandboxes.get(WORKSPACE_NAME)!.spec as { operatingMode: string }).operatingMode =
				'Suspended'
			livePodUid = undefined
			nativePolicy = policy
			await expect(
				openKubernetesWorkspaceVolumeForClosure(config, {
					...volumeOptions(),
					expectedAllocation: allocation,
				}),
			).rejects.toThrow()
			expect(sandboxPatches()).toHaveLength(0)
			expect(agentOperations()).toHaveLength(0)
		},
	)
	it('refuses changed actual content on read-only inspection despite intact labels and profile annotation', async () => {
		const { config, allocation } = await allocateNativeProfile()
		const object = sandboxes.get(WORKSPACE_NAME)! as {
			spec: { podTemplate: { spec: { containers: { image: string }[] } } }
		}
		object.spec.podTemplate.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
		await expect(
			inspectKubernetesWorkspaceVolume(config, WORKSPACE_ID, {
				epoch: 4,
				expectedAllocation: allocation,
			}),
		).rejects.toThrow()
		expect(sandboxPatches()).toHaveLength(0)
		expect(agentOperations()).toHaveLength(0)
	})
	it.each(['suspend', 'delete'] as const)(
		'refuses %s when actual original content changes during held flush',
		async (action) => {
			const entered = barrier()
			const release = barrier()
			await agent!.close()
			agent = await startScriptedAgent({
				token: FIRST_POD_UID,
				guestBootId: FIRST_BOOT,
				guestBound: true,
				features: ['sessions', 'flush'],
				sessionsReply: { ok: true, sessions: [] },
				flushReply: { ok: true, guestBootId: FIRST_BOOT, durationMs: 1, workspace: '/workspace' },
				beforeFlush: async () => {
					entered.release()
					await release.promise
				},
			})
			const { config, allocation } = await allocateNativeProfile()
			const held = await openKubernetesWorkspaceForClosure(config, {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
				identity: closureIdentity(),
				epoch: 4,
				expectedAllocation: allocation,
			})
			const stopping = (
				action === 'suspend'
					? held.suspend({ expectedIdentity: closureIdentity(), epoch: 4 })
					: held.destroy({ expectedIdentity: closureIdentity(), epoch: 4, deleteDisk: true })
			).catch((error: unknown) => error)
			await entered.promise
			const object = sandboxes.get(WORKSPACE_NAME)!
			;(object.spec as { podTemplate: { spec: { containers: { image: string }[] } } }).podTemplate
				.spec.containers[0]!.image = `image@sha256:${'b'.repeat(64)}`
			metaOf(object).resourceVersion = nextResourceVersion()
			release.release()
			expect(await stopping).toBeInstanceOf(Error)
			expect(sandboxPatches()).toHaveLength(0)
			expect(requestsBy('DELETE')).toHaveLength(0)
		},
	)
})
