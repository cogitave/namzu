/**
 * Managing workspaces without waking them, and a handle that finds out its
 * workspace was suspended by somebody else.
 *
 * Both halves of one problem. `createKubernetesWorkspace` adopts AND resumes,
 * which is exactly right for a host about to use a workspace and exactly
 * wrong for every operation that is about the OBJECT: an inventory taken
 * through it starts a pod for every suspended workspace it looks at, and
 * deleting a month-old one means waking it up to tell it to go away. So
 * `listKubernetesWorkspaces`, `deleteKubernetesWorkspace` and
 * `suspendKubernetesWorkspace` reach the object without opening it, and the
 * assertions here are mostly about what they do NOT send — no PATCH from a
 * list, no Running patch from a delete, no pod read and no dial from either.
 *
 * The other half is what that does to a handle somebody is already holding.
 * A workspace id is a name, not a lock, so a second process can suspend the
 * workspace this one is using, and a handle's own state is a record of what
 * ITS process did. The failure that produces names nothing on its own — the
 * pod is gone, so the dial is refused against an address that still resolves
 * because the Service outlives the pod, or the replacement pod's agent
 * answers a flat `unauthorized` — so the object is re-read once per failed
 * call and, if it really is suspended, the caller is told that instead. The
 * same re-read is available on demand as `refresh()`, before anything has
 * failed at all.
 *
 * Throughout: the suspend is recorded UNCONFIRMED. What was observed is the
 * object's mode, not the pod stopping, and only a wait this process performed
 * can promise a quiesced disk.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point: all four verbs are public surface,
// and the config shape they take is the exported one.
import {
	type KubernetesBackendConfig,
	createKubernetesWorkspace,
	deleteKubernetesWorkspace,
	listKubernetesWorkspaces,
	suspendKubernetesWorkspace,
} from '../../../index.js'
import { KubernetesAlreadyGoneError } from '../k8s-client.js'
import {
	KubernetesWorkspaceSuspendTimeoutError,
	KubernetesWorkspaceSuspendedError,
} from '../workspace.js'

import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	operatingModePatchBody,
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
/** The pod this handle was bound to, and the one a resume brings up. */
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
/**
 * Written out rather than imported: it is a name that goes onto a cluster
 * object and is read back by a later release, so a rename has to break a test
 * rather than follow the constant silently.
 */
const MODE_CHANGED_AT = 'sandbox.namzu.ai/operating-mode-changed-at'
/** A token no handle in this suite holds: the pod behind it is gone. */
const RETIRED_TOKEN = '99999999-9999-4999-8999-999999999999'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
const CREATED_AT = '2026-08-01T09:00:00Z'

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

/** One object in the fake namespace, as much of it as anything here reads. */
interface FakeSandbox {
	name: string
	operatingMode: 'Running' | 'Suspended'
	annotations: Record<string, string>
	creationTimestamp: string
	/** The backend-owned label on `spec.podTemplate`; absent = not ours. */
	templateLabel?: string
	/** A workspace always carries a block disk; a task sandbox never does. */
	disk: boolean
}

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

/** The namespace's objects, by name. */
let sandboxes: Map<string, FakeSandbox>
/** The uid the pod behind the workspace answers with; `undefined` = 404. */
let livePodUid: string | undefined
/** Pod GETs still to be answered with the pod that is draining. */
let drainingGets: number
/** Whose uid that draining pod carries. */
let drainingUid: string
/** The uid the pod brought up by the next Running patch will carry. */
let nextPodUid: string
/** How long the pod rides out its grace period after a Suspended patch. */
let drainOnSuspend: number
/** DELETEs the API server refuses with a 500 before accepting one. */
let refusedDeletes: number

beforeEach(async () => {
	sandboxes = new Map()
	livePodUid = FIRST_POD_UID
	drainingGets = 0
	drainingUid = FIRST_POD_UID
	nextPodUid = SECOND_POD_UID
	drainOnSuspend = 1
	refusedDeletes = 0
	agent = await startScriptedAgent({ token: FIRST_POD_UID })
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

function workspaceEntry(overrides: Partial<FakeSandbox> = {}): FakeSandbox {
	return {
		name: WORKSPACE_NAME,
		operatingMode: 'Running',
		annotations: {},
		creationTimestamp: CREATED_AT,
		templateLabel: TEMPLATE_NAME,
		disk: true,
		...overrides,
	}
}

function livePod(uid: string): Record<string, unknown> {
	return { metadata: { name: WORKSPACE_NAME, uid }, status: { phase: 'Running' } }
}

/**
 * The pod on its way out: same name, old uid, a `deletionTimestamp` — and
 * phase `Running`, because the container does not stop when the DELETE is
 * accepted. Neither live (never bind it) nor stopped (it is still writing).
 */
function terminatingPod(uid: string): Record<string, unknown> {
	return {
		metadata: { name: WORKSPACE_NAME, uid, deletionTimestamp: '2026-09-16T00:00:01Z' },
		status: { phase: 'Running' },
	}
}

function sandboxBody(entry: FakeSandbox): Record<string, unknown> {
	return {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: {
			name: entry.name,
			namespace: NAMESPACE,
			creationTimestamp: entry.creationTimestamp,
			...(Object.keys(entry.annotations).length > 0 ? { annotations: entry.annotations } : {}),
		},
		spec: {
			operatingMode: entry.operatingMode,
			...(entry.disk ? { volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates } : {}),
			podTemplate: {
				metadata:
					entry.templateLabel !== undefined
						? { labels: { [TEMPLATE_LABEL]: entry.templateLabel } }
						: {},
				spec: TEMPLATE.spec.podTemplate.spec,
			},
		},
		status: {
			// Ready stays True across a transition, which is what makes the pod
			// uid the only usable signal — see workspace-suspend-resume.test.ts.
			conditions: [readyCondition(entry.operatingMode === 'Suspended' ? 'False' : 'True')],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${entry.name}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
}

/** The last path segment, query string stripped. */
function objectName(path: string): string {
	const withoutQuery = path.split('?')[0] ?? ''
	return decodeURIComponent(withoutQuery.split('/').pop() ?? '')
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	// Before the by-name branches: a collection path has no trailing segment.
	if (req.method === 'GET' && req.path.endsWith('/sandboxes')) {
		return { status: 200, body: { items: [...sandboxes.values()].map(sandboxBody) } }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		if (sandboxes.has(WORKSPACE_NAME)) {
			return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
		}
		sandboxes.set(WORKSPACE_NAME, workspaceEntry())
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const entry = sandboxes.get(objectName(req.path))
		if (!entry) return { status: 404, body: { message: 'gone' } }
		const body = req.body as {
			metadata?: { annotations?: Record<string, string> }
			spec?: { operatingMode?: string }
		}
		// RFC 7386: a merge patch recurses into the annotation map rather than
		// replacing it, so annotations somebody else set survive.
		Object.assign(entry.annotations, body.metadata?.annotations ?? {})
		const mode = body.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running'
		if (mode !== entry.operatingMode) {
			if (mode === 'Suspended') {
				drainingUid = livePodUid ?? drainingUid
				drainingGets = drainOnSuspend
				livePodUid = undefined
				// The guest goes with the pod. A handle still holding the old
				// token now meets whatever is listening at an address the
				// Service keeps resolving, and is refused by it — which is the
				// least informative failure a foreign suspend can produce, and
				// the one this suite is about.
				agent?.setToken(RETIRED_TOKEN)
			} else {
				// A resumed pod keeps the sandbox's name and gets a new uid —
				// and a new agent, bound to that uid.
				drainingGets = 0
				livePodUid = nextPodUid
				agent?.setToken(nextPodUid)
			}
		}
		entry.operatingMode = mode
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		const entry = sandboxes.get(objectName(req.path))
		if (!entry) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: sandboxBody(entry) }
	}
	if (req.method === 'DELETE' && req.path.includes('/sandboxes/')) {
		if (refusedDeletes > 0) {
			refusedDeletes -= 1
			return { status: 500, body: { message: 'etcdserver: request timed out' } }
		}
		const name = objectName(req.path)
		if (!sandboxes.delete(name)) return { status: 404, body: { message: 'gone' } }
		livePodUid = undefined
		return { status: 200, body: { kind: 'Status' } }
	}
	// Before `/pods/`: the list path is `/pods?labelSelector=…`. It reads the
	// same state without consuming it — the GET above is the read that moves
	// the drain along, and a list that decremented too would skip a beat.
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		if (drainingGets > 0) return { status: 200, body: { items: [terminatingPod(drainingUid)] } }
		return { status: 200, body: { items: livePodUid ? [livePod(livePodUid)] : [] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (drainingGets > 0) {
			drainingGets -= 1
			return { status: 200, body: terminatingPod(drainingUid) }
		}
		if (livePodUid === undefined) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: livePod(livePodUid) }
	}
	return { status: 404, body: { message: 'unexpected' } }
}

function clusterConfig(overrides: { readyTimeoutMs?: number } = {}): KubernetesBackendConfig {
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
		...overrides,
	}
}

async function openWorkspace(overrides: { readyTimeoutMs?: number } = {}) {
	return await createKubernetesWorkspace(clusterConfig(overrides), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: '/workspace',
	})
}

/** Every token the guest has seen in a request envelope, in order. */
function presentedTokens(): string[] {
	if (!agent) throw new Error('fixtures not started')
	return agent.requests
		.map((request) => request.token)
		.filter((token): token is string => typeof token === 'string')
}

function requestsBy(method: string): readonly RecordedRequest[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests.filter((r) => r.method === method)
}

describe('a suspend performed by another process', () => {
	it('names the suspension on the next call and resumes onto the same disk', async () => {
		// Process B, holding a handle and using it.
		const held = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		expect((await held.exec('true')).exitCode).toBe(0)
		expect(held.suspended).toBe(false)

		// Process A, holding nothing: it suspends by name, adopting nothing
		// and resuming nothing.
		await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)
		expect(sandboxes.get(WORKSPACE_NAME)?.operatingMode).toBe('Suspended')

		// What B meets next. The pod it was bound to went with the suspend, so
		// its token is refused — a flat `unauthorized`, from an address that
		// still resolves because the Service outlived the pod. That failure
		// says nothing about a suspend on its own.
		const failure = await held.exec('true').catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		const suspended = failure as KubernetesWorkspaceSuspendedError
		expect(suspended.noticedBy).toBe('transport')
		expect(suspended.workspaceId).toBe(WORKSPACE_ID)
		expect(suspended.message).toMatch(/another process suspended/)
		// The failure that prompted the re-read is carried, not swallowed.
		expect(suspended.cause).toBeInstanceOf(Error)
		expect(held.suspended).toBe(true)
		expect(held.status).toBe('destroyed')

		// And the way back is the ordinary one, onto the same disk: a new pod
		// with a new uid, and nothing deleted anywhere along the way.
		await held.resume()
		expect(held.suspended).toBe(false)
		expect((await held.exec('true')).exitCode).toBe(0)
		expect(presentedTokens().at(-1)).toBe(SECOND_POD_UID)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(sandboxes.get(WORKSPACE_NAME)?.disk).toBe(true)
	}, 20_000)

	it('records the foreign suspend as unconfirmed, so the next suspend still waits', async () => {
		// The handle saw the MODE, not the pod stopping. Process A's wait may
		// have run out; this process never waited at all. A `suspended` mark
		// here would let this handle's own suspend() return on it and promise
		// a quiesced disk nobody in this process waited for.
		const held = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)
		await held.refresh()
		expect(held.suspended).toBe(true)

		const patchesBefore = requestsBy('PATCH').length
		await held.suspend()
		expect(requestsBy('PATCH').length).toBe(patchesBefore + 1)
	}, 20_000)

	it('is reported by refresh() before anything has failed', async () => {
		const held = await openWorkspace()
		if (!server || !agent) throw new Error('fixtures not started')
		await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)
		// Nothing has failed yet, so the handle still believes what it last
		// did — which is the state this verb exists to correct.
		expect(held.suspended).toBe(false)

		await held.refresh()

		expect(held.suspended).toBe(true)
		const dials = agent.connections.length
		const failure = await held.exec('true').catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		// Admission, not a transport failure: this one knew, and nothing was
		// dialed.
		expect((failure as KubernetesWorkspaceSuspendedError).noticedBy).toBe('admission')
		expect((failure as Error).message).toMatch(/nothing was dialed/)
		expect(agent.connections.length).toBe(dials)

		await held.resume()
		expect((await held.exec('true')).exitCode).toBe(0)
	}, 20_000)

	it('hands back a failure of its own when the workspace is still Running', async () => {
		// The re-read is a question, not a conclusion. A guest that refuses a
		// token for any other reason — a pod replaced by a rollout, a bug —
		// must not be reported as a suspension the caller could resume from.
		const held = await openWorkspace()
		agent?.setToken('somebody-elses-pod')

		const failure = await held.exec('true').catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).not.toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect(held.suspended).toBe(false)
		expect(held.status).toBe('ready')
	}, 20_000)

	it('re-reads the object once per failed call and never on one that worked', async () => {
		const held = await openWorkspace()
		if (!server) throw new Error('fixtures not started')
		const reads = () => server?.matching('GET', `/sandboxes/${WORKSPACE_NAME}`).length ?? 0

		const afterSuccess = reads()
		expect((await held.exec('true')).exitCode).toBe(0)
		expect(reads()).toBe(afterSuccess)

		agent?.setToken('somebody-elses-pod')
		await held.exec('true').catch(() => undefined)
		expect(reads()).toBe(afterSuccess + 1)
		await held.exec('true').catch(() => undefined)
		expect(reads()).toBe(afterSuccess + 2)
	}, 20_000)
})

describe('listing workspaces', () => {
	it('reports running and suspended workspaces and changes none of them', async () => {
		sandboxes.set(
			'namzu-ws-awake',
			workspaceEntry({ name: 'namzu-ws-awake', operatingMode: 'Running' }),
		)
		sandboxes.set(
			'namzu-ws-asleep',
			workspaceEntry({
				name: 'namzu-ws-asleep',
				operatingMode: 'Suspended',
				annotations: { [MODE_CHANGED_AT]: '2026-09-10T12:00:00Z' },
			}),
		)
		// A task sandbox: this backend's label, no workspace name.
		sandboxes.set('sbx-7f3a', workspaceEntry({ name: 'sbx-7f3a', disk: false }))
		// And an object wearing a workspace name that this backend did not
		// build — no template label, so nothing here can say what its pod is.
		sandboxes.set(
			'namzu-ws-stranger',
			workspaceEntry({ name: 'namzu-ws-stranger', templateLabel: undefined }),
		)
		if (!server || !agent) throw new Error('fixtures not started')

		const listed = await listKubernetesWorkspaces(clusterConfig())

		expect(listed.map((w) => w.workspaceId).sort()).toEqual(['asleep', 'awake'])
		const asleep = listed.find((w) => w.workspaceId === 'asleep')
		expect(asleep?.operatingMode).toBe('Suspended')
		expect(asleep?.template).toBe(TEMPLATE_NAME)
		expect(asleep?.createdAt).toBe(CREATED_AT)
		expect(asleep?.operatingModeChangedAt).toBe('2026-09-10T12:00:00Z')
		const awake = listed.find((w) => w.workspaceId === 'awake')
		expect(awake?.operatingMode).toBe('Running')
		// Never stamped, so reported absent rather than defaulted to
		// `createdAt`: a retention rule has to tell "never suspended" from
		// "suspended a month ago".
		expect(awake?.operatingModeChangedAt).toBeUndefined()

		// Nothing was woken, and nothing was touched: one GET of the
		// collection, and that is the whole conversation.
		expect(server.requests).toHaveLength(1)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(requestsBy('POST')).toHaveLength(0)
		expect(server.matching('GET', '/pods')).toHaveLength(0)
		expect(agent.connections).toHaveLength(0)
		expect(sandboxes.get('namzu-ws-asleep')?.operatingMode).toBe('Suspended')
		expect(sandboxes.get('namzu-ws-awake')?.operatingMode).toBe('Running')
	})

	it('reads back the annotation each transition stamps', async () => {
		const workspace = await openWorkspace()
		if (!server) throw new Error('fixtures not started')

		// Created and never transitioned: nothing to report.
		expect((await listKubernetesWorkspaces(clusterConfig()))[0]?.operatingModeChangedAt).toBe(
			undefined,
		)

		await workspace.suspend()
		const afterSuspend = (await listKubernetesWorkspaces(clusterConfig()))[0]
		expect(afterSuspend?.operatingMode).toBe('Suspended')
		// Read back exactly as the patch wrote it, and a real RFC 3339 instant.
		const stamped = sandboxes.get(WORKSPACE_NAME)?.annotations[MODE_CHANGED_AT]
		expect(afterSuspend?.operatingModeChangedAt).toBe(stamped)
		expect(Number.isNaN(Date.parse(stamped ?? ''))).toBe(false)

		await workspace.resume()
		const afterResume = (await listKubernetesWorkspaces(clusterConfig()))[0]
		expect(afterResume?.operatingMode).toBe('Running')
		// The resume stamped its own moment over the suspend's.
		expect(Date.parse(afterResume?.operatingModeChangedAt ?? '')).toBeGreaterThanOrEqual(
			Date.parse(stamped ?? ''),
		)
		expect(afterResume?.operatingModeChangedAt).toBe(
			sandboxes.get(WORKSPACE_NAME)?.annotations[MODE_CHANGED_AT],
		)
	}, 20_000)
})

describe('deleting a workspace', () => {
	it('removes a suspended workspace without starting a pod', async () => {
		sandboxes.set(WORKSPACE_NAME, workspaceEntry({ operatingMode: 'Suspended' }))
		livePodUid = undefined
		if (!server || !agent) throw new Error('fixtures not started')

		await deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)

		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
		const deletes = requestsBy('DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toContain(`/sandboxes/${WORKSPACE_NAME}`)
		// Nothing woke it on the way out: no Running patch, no template read,
		// no pod read, no dial. One request, and it is the DELETE.
		expect(server.requests).toHaveLength(1)
		expect(requestsBy('PATCH')).toHaveLength(0)
		expect(server.matching('GET', '/pods')).toHaveLength(0)
		expect(agent.connections).toHaveLength(0)
	})

	it('counts an object that is already gone as deleted', async () => {
		// The state DELETE was asking for. A retention pass racing another
		// one, or retrying its own, must not fail on the second attempt.
		await expect(deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)).resolves.toBeUndefined()
	})

	it('rejects and stays retryable when the DELETE fails', async () => {
		// Nothing records the workspace as deleted on a request that did not
		// land, so the retry sends the DELETE again instead of returning on a
		// mark nothing established.
		sandboxes.set(WORKSPACE_NAME, workspaceEntry({ operatingMode: 'Suspended' }))
		refusedDeletes = 1

		await expect(deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)).rejects.toThrow(/500/)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(true)

		await deleteKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)
		expect(sandboxes.has(WORKSPACE_NAME)).toBe(false)
	})

	it('refuses a workspace id that could not name a Sandbox', async () => {
		// Before any request: the id is refused rather than sanitised, because
		// two ids that sanitise to one name would delete one another's disk.
		await expect(deleteKubernetesWorkspace(clusterConfig(), 'Not A Label')).rejects.toThrow(
			/cannot name a Sandbox/,
		)
		expect(requestsBy('DELETE')).toHaveLength(0)
	})
})

describe('suspending a workspace without adopting it', () => {
	it('waits for the pod to go, and never opens the workspace', async () => {
		sandboxes.set(WORKSPACE_NAME, workspaceEntry())
		drainOnSuspend = 3
		if (!server || !agent) throw new Error('fixtures not started')

		await suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)

		expect(sandboxes.get(WORKSPACE_NAME)?.operatingMode).toBe('Suspended')
		const patches = requestsBy('PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.path).toContain(`/sandboxes/${WORKSPACE_NAME}`)
		expect(patches[0]?.body).toEqual(operatingModePatchBody('Suspended'))
		// Three draining reads and the 404 that ended it: the patch being
		// accepted is not the answer, the pod stopping is.
		expect(drainingGets).toBe(0)
		expect(server.matching('GET', '/pods/').length).toBeGreaterThanOrEqual(4)
		// And nothing else at all: no template read, no POST, no dial.
		expect(server.matching('GET', '/sandboxtemplates/')).toHaveLength(0)
		expect(requestsBy('POST')).toHaveLength(0)
		expect(requestsBy('DELETE')).toHaveLength(0)
		expect(agent.connections).toHaveLength(0)
	}, 20_000)

	it('refuses, without deleting anything, when the pod outlives the budget', async () => {
		sandboxes.set(WORKSPACE_NAME, workspaceEntry())
		// A guest whose PID 1 ignores SIGTERM for longer than the wait allows.
		drainOnSuspend = Number.POSITIVE_INFINITY

		const failure = await suspendKubernetesWorkspace(
			clusterConfig({ readyTimeoutMs: 300 }),
			WORKSPACE_ID,
		).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendTimeoutError)
		expect((failure as Error).message).toMatch(/terminationGracePeriodSeconds/)
		// The patch landed, so the object is asleep and the disk is untouched:
		// the next call patches and waits again.
		expect(sandboxes.get(WORKSPACE_NAME)?.operatingMode).toBe('Suspended')
		expect(requestsBy('DELETE')).toHaveLength(0)
	}, 20_000)

	it('refuses a workspace that is not there rather than resolving', async () => {
		// Unlike a DELETE, this asks for a state that cannot be reached: there
		// is no object to suspend, and nothing the caller believed holds.
		await expect(suspendKubernetesWorkspace(clusterConfig(), WORKSPACE_ID)).rejects.toBeInstanceOf(
			KubernetesAlreadyGoneError,
		)
	})
})
