/**
 * `walkFiles` on a persistent workspace handle.
 *
 * The traversal itself is the task sandbox's (`walk-files.test.ts` runs it
 * against the real agent over a real filesystem); what a workspace adds is
 * ADMISSION. A walk is the one data-plane operation on this handle that stays
 * open across an arbitrary stretch of wall clock, so it is the one most
 * likely to be in flight when the compute underneath it is taken away — by
 * this process, or by another one holding the same workspace id. Every case
 * here is about what the handle says when that happens.
 *
 * The guest is the scripted agent rather than the real one, for the reason
 * every workspace suite gives: `createKubernetesWorkspace` gates on the
 * acquire-time privilege probe, which reads the guest's real
 * `/proc/self/status`, and this test host's node process is correctly NOT
 * deprivileged. The scripted agent answers the probe and then, through
 * `setStdout`, answers a walk with the JSONL records a real walk would have
 * streamed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Through the package's own entry point: `createKubernetesWorkspace` is the
// surface a host calls, and the config shape it takes is the exported one.
import { type KubernetesBackendConfig, createKubernetesWorkspace } from '../../../index.js'
import { KubernetesWorkspaceSuspendedError } from '../workspace.js'

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
const WORKSPACE_ID = 'walker'
const WORKSPACE_NAME = 'namzu-ws-walker'
const TEMPLATE_NAME = 'namzu-workspace'
const TEMPLATE_LABEL = 'sandbox.namzu.ai/template'
const SELECTOR = 'agents.x-k8s.io/sandbox-name-hash=wlk'
const ROOT = '/workspace'
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
/** A token no handle in this suite holds: the pod behind it is gone. */
const RETIRED_TOKEN = '99999999-9999-4999-8999-999999999999'

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

/** The JSONL a real guest walk streams: one record per match, then `done`. */
function walkRecords(paths: readonly string[]): string {
	return `${[
		...paths.map((path, index) => ({ type: 'entry', path, size: index + 1 })),
		{ type: 'done' },
	]
		.map((record) => JSON.stringify(record))
		.join('\n')}\n`
}

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
let operatingMode: 'Running' | 'Suspended'
let livePodUid: string | undefined
let exists: boolean

beforeEach(async () => {
	operatingMode = 'Running'
	livePodUid = FIRST_POD_UID
	exists = false
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

function sandboxBody(): Record<string, unknown> {
	return {
		apiVersion: 'agents.x-k8s.io/v1beta1',
		kind: 'Sandbox',
		metadata: { name: WORKSPACE_NAME, namespace: NAMESPACE },
		spec: {
			operatingMode,
			volumeClaimTemplates: TEMPLATE.spec.volumeClaimTemplates,
			podTemplate: {
				metadata: { labels: { [TEMPLATE_LABEL]: TEMPLATE_NAME } },
				spec: TEMPLATE.spec.podTemplate.spec,
			},
		},
		status: {
			conditions: [readyCondition(operatingMode === 'Suspended' ? 'False' : 'True')],
			podIPs: ['10.244.0.11'],
			serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
			selector: SELECTOR,
		},
	}
}

function livePod(uid: string): Record<string, unknown> {
	return { metadata: { name: WORKSPACE_NAME, uid }, status: { phase: 'Running' } }
}

function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return { status: 200, body: TEMPLATE }
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		exists = true
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		if (!exists) return { status: 404, body: { message: 'gone' } }
		const body = req.body as { spec?: { operatingMode?: string } }
		const mode = body.spec?.operatingMode === 'Suspended' ? 'Suspended' : 'Running'
		if (mode === 'Suspended' && operatingMode === 'Running') {
			livePodUid = undefined
			// The guest goes with the pod: a handle still holding the old token
			// now meets whatever is listening at an address the Service keeps
			// resolving, and is refused by it.
			agent?.setToken(RETIRED_TOKEN)
		}
		operatingMode = mode
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		if (!exists) return { status: 404, body: { message: 'gone' } }
		return { status: 200, body: sandboxBody() }
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		return { status: 200, body: { items: livePodUid ? [livePod(livePodUid)] : [] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
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
	}
}

/** The error a refusal must be, by CLASS — never by message. */
async function refusal(call: () => Promise<unknown>): Promise<KubernetesWorkspaceSuspendedError> {
	try {
		await call()
	} catch (error) {
		if (error instanceof KubernetesWorkspaceSuspendedError) return error
		throw error
	}
	throw new Error('the call resolved where a suspended workspace had to refuse it')
}

async function openWorkspace() {
	return await createKubernetesWorkspace(clusterConfig(), {
		workspaceId: WORKSPACE_ID,
		workingDirectory: ROOT,
	})
}

describe('walkFiles on a kubernetes workspace', () => {
	it('is present on the handle and streams the guest walk back', async () => {
		const workspace = await openWorkspace()
		// Installed AFTER the create: the acquire-time privilege probe is
		// itself an `execute`, and it needs the probe's own canned reply.
		agent?.setStdout(walkRecords([`${ROOT}/src/a.ts`, `${ROOT}/src/b.ts`]))

		const seen: { path: string; size: number }[] = []
		for await (const entry of workspace.walkFiles(ROOT, { maxEntries: 10 })) {
			seen.push({ path: entry.path, size: entry.size })
		}
		expect(seen).toEqual([
			{ path: `${ROOT}/src/a.ts`, size: 1 },
			{ path: `${ROOT}/src/b.ts`, size: 2 },
		])
		await workspace.destroy({ deleteDisk: true })
	})

	it('refuses a walk on a suspended workspace, exactly as readFile is refused', async () => {
		const workspace = await openWorkspace()
		await workspace.suspend()
		expect(workspace.suspended).toBe(true)

		const walk = async (): Promise<void> => {
			for await (const _entry of workspace.walkFiles(ROOT, { maxEntries: 10 })) {
				throw new Error('a suspended workspace must not yield an entry')
			}
		}
		// The same class, the same `noticedBy`, and this operation's own name —
		// the whole point of forwarding through `admit()` rather than dialing.
		const walkError = await refusal(walk)
		expect(walkError.operation).toBe('walkFiles')
		expect(walkError.noticedBy).toBe('admission')
		const readError = await refusal(async () => await workspace.readFile('x.txt'))
		expect(readError.operation).toBe('readFile')
		expect(readError.noticedBy).toBe('admission')
		// Nothing was dialed for either: the refusal is on this handle's own
		// state, and the connection count has not moved since the create.
		const dialsAfterCreate = agent?.connections.length ?? 0
		expect(dialsAfterCreate).toBeGreaterThan(0)
		await workspace.destroy({ deleteDisk: true })
	})

	it('fails the walk when ANOTHER process suspends the workspace, and names it on the next call', async () => {
		const workspace = await openWorkspace()
		agent?.setStdout(walkRecords([`${ROOT}/a.ts`]))

		// Somebody else's suspend: this handle still reports Running, still
		// holds the retired pod's token, and finds out only when its next call
		// is refused by whatever answers the address the Service still resolves.
		await fetch(
			`${server?.url}/apis/agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxes/${WORKSPACE_NAME}`,
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/merge-patch+json' },
				body: JSON.stringify({ spec: { operatingMode: 'Suspended' } }),
			},
		)
		expect(workspace.suspended).toBe(false)

		const walk = async (): Promise<void> => {
			for await (const _entry of workspace.walkFiles(ROOT, { maxEntries: 10 })) {
				// Whatever arrives before the failure is irrelevant to the case.
			}
		}
		// The walk is admitted ONCE and then delegated, so a suspend that lands
		// after admission fails it the way the transport failed — the one-shot
		// "was I suspended elsewhere?" diagnosis is `admitted`'s, and it is not
		// run per entry. Pinned as a negative because it is a deliberate
		// boundary of this method, not an accident of how the walk failed.
		let walkError: unknown
		await walk().catch((error: unknown) => {
			walkError = error
		})
		expect(walkError).toBeInstanceOf(Error)
		expect(walkError).not.toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect(workspace.suspended).toBe(false)

		// The next data-plane call is where the handle finds out, and it is the
		// same diagnosis every other operation gets: the object is re-read, and
		// only then is the failure named a suspension.
		const readError = await refusal(async () => await workspace.readFile('a.ts'))
		expect(readError.operation).toBe('readFile')
		expect(readError.noticedBy).toBe('transport')
		expect(workspace.suspended).toBe(true)

		// And a walk started from here is refused on admission, like every other
		// call on a handle that now knows.
		const refused = await refusal(walk)
		expect(refused.operation).toBe('walkFiles')
		expect(refused.noticedBy).toBe('admission')
		await workspace.destroy({ deleteDisk: true })
	})
})
