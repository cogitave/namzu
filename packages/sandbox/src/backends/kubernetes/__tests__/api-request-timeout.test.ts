/**
 * The per-request API bound where it actually matters: the SHARED flights.
 *
 * `k8s-client.test.ts` proves the bound holds on both transports and covers
 * `getToken()`. This file proves the thing the bound exists for. A workspace
 * `suspend()` is single-flight and runs under the FIRST caller's signal;
 * later `suspend()` and plain `destroy()` calls await that same promise and
 * their own signals are never consulted, and a queued `resume()` does not
 * reach its turn at all. So one signal-less call against an API server that
 * accepted a PATCH and never answered used to pin every caller on the handle
 * — on a handle whose state is already `suspending`, which refuses every
 * data-plane call. A host calling `destroy()` during shutdown hung until it
 * was killed.
 *
 * The API server here does not refuse or reset: it accepts the request,
 * holds the response open, and answers only when a case lifts the stall.
 * That is the failure the bound is for; a refusal was never the problem.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createKubernetesWorkspace, createSandboxProvider } from '../../../index.js'
import { KubernetesApiTimeoutError } from '../k8s-client.js'

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
const WORKSPACE_ID = 'stalled'
const WORKSPACE_NAME = 'namzu-ws-stalled'
const POD_UID = '11111111-1111-4111-8111-111111111111'
/** The floor, so a case costs a second rather than thirty. */
const BOUND_MS = 1_000

const TEMPLATE = {
	metadata: { name: 'namzu-workspace', namespace: NAMESPACE },
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

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined
let suspended: boolean
/** Which request shape is currently held open, if any. */
let stall: 'none' | 'patch' | 'template' | 'networkpolicy'
/** Resolvers for every held response, released in `afterEach` no matter what. */
let held: (() => void)[]

function hold(reply: FakeApiReply): Promise<FakeApiReply> {
	return new Promise<FakeApiReply>((resolve) => {
		held.push(() => resolve(reply))
	})
}

beforeEach(async () => {
	suspended = false
	stall = 'none'
	held = []
	agent = await startScriptedAgent({ token: POD_UID })
	restoreDns = stubLoopbackDns()
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	// Released BEFORE the close, so no handler is still pending on a socket
	// the server is trying to shut down.
	for (const release of held.splice(0)) release()
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

function handleClusterRequest(req: RecordedRequest): FakeApiReply | Promise<FakeApiReply> {
	if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
		const reply: FakeApiReply = { status: 404, body: { message: 'not found' } }
		return stall === 'networkpolicy' ? hold(reply) : reply
	}
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		const reply: FakeApiReply = { status: 200, body: TEMPLATE }
		return stall === 'template' ? hold(reply) : reply
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		const mode = (req.body as { spec?: { operatingMode?: string } }).spec?.operatingMode
		const apply = (): FakeApiReply => {
			suspended = mode === 'Suspended'
			return { status: 200, body: {} }
		}
		if (stall === 'patch') {
			return new Promise<FakeApiReply>((resolve) => {
				held.push(() => resolve(apply()))
			})
		}
		return apply()
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		return {
			status: 200,
			body: {
				metadata: { name: WORKSPACE_NAME },
				spec: { operatingMode: suspended ? 'Suspended' : 'Running' },
				status: {
					conditions: [readyCondition(suspended ? 'False' : 'True')],
					podIPs: ['10.244.0.6'],
					serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
					selector: 'agents.x-k8s.io/sandbox-name-hash=stl',
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods?')) {
		return { status: 200, body: { items: [] } }
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (suspended) return { status: 404, body: { message: 'gone' } }
		return {
			status: 200,
			body: { metadata: { name: WORKSPACE_NAME, uid: POD_UID }, status: { phase: 'Running' } },
		}
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

async function openWorkspace(apiRequestTimeoutMs: number | undefined = BOUND_MS) {
	if (!server || !agent) throw new Error('fixtures not started')
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort: agent.port,
			readyTimeoutMs: 4_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
			...(apiRequestTimeoutMs !== undefined ? { apiRequestTimeoutMs } : {}),
		},
		{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
	)
}

describe('a stalled API server no longer pins a workspace handle', () => {
	it('rejects a signal-less suspend() with the named error, and the handle keeps working', async () => {
		const workspace = await openWorkspace()
		stall = 'patch'
		const started = Date.now()
		const failure = await workspace.suspend().then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(failure).toBeInstanceOf(KubernetesApiTimeoutError)
		expect(Date.now() - started).toBeLessThan(BOUND_MS * 4)
		// The patch changed nothing the handle can see, so it must not claim
		// the workspace is asleep.
		expect(workspace.suspended).toBe(false)
		// And it is still a usable handle, not a fenced one.
		await expect(workspace.exec('/bin/true')).resolves.toMatchObject({ exitCode: 0 })
	}, 30_000)

	it('settles a destroy() joined to that suspend and a resume() queued behind it', async () => {
		const workspace = await openWorkspace()
		stall = 'patch'
		const started = Date.now()
		// Exactly the shutdown shape: the first caller passed no signal, the
		// second is `what a finally block calls`, and the third is waiting for
		// a turn that used never to come.
		const first = workspace.suspend().catch((err: unknown) => err)
		const joined = workspace.destroy().catch((err: unknown) => err)
		const queued = workspace.resume().catch((err: unknown) => err)
		const [a, b, c] = await Promise.all([first, joined, queued])
		expect(Date.now() - started).toBeLessThan(BOUND_MS * 8)
		expect(a).toBeInstanceOf(KubernetesApiTimeoutError)
		// The joined destroy sees the same failure; the queued resume reaches
		// its turn at all, which is the whole acceptance criterion.
		expect(b).toBeInstanceOf(Error)
		expect(c === undefined || c instanceof Error).toBe(true)
	}, 30_000)

	it('resolves suspend() once the stall is lifted', async () => {
		const workspace = await openWorkspace()
		stall = 'patch'
		await expect(workspace.suspend()).rejects.toBeInstanceOf(KubernetesApiTimeoutError)
		stall = 'none'
		for (const release of held.splice(0)) release()
		await workspace.suspend()
		expect(workspace.suspended).toBe(true)
	}, 30_000)

	it('rejects a signal-less createKubernetesWorkspace within the bound', async () => {
		stall = 'template'
		const started = Date.now()
		await expect(openWorkspace()).rejects.toBeInstanceOf(KubernetesApiTimeoutError)
		expect(Date.now() - started).toBeLessThan(BOUND_MS * 4)
	}, 30_000)

	it('rejects a task create() whose egress verification stalls', async () => {
		if (!server || !agent) throw new Error('fixtures not started')
		stall = 'networkpolicy'
		const provider = createSandboxProvider({
			backend: {
				tier: 'microvm',
				service: 'kubernetes',
				access: { server: server.url, getToken: async () => 'sa-token' },
				namespace: NAMESPACE,
				sandboxTemplateName: 'namzu-task',
				agentPort: agent.port,
				readyTimeoutMs: 4_000,
				readyPollIntervalMs: 5,
				apiRequestTimeoutMs: BOUND_MS,
				egress: { policy: { kind: 'deny-all' } },
			},
		})
		const started = Date.now()
		const failure = await provider.create({ workingDirectory: '/workspace' }).then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(failure).toBeInstanceOf(Error)
		expect(String(failure)).toMatch(/timed|unanswered|apiRequestTimeoutMs/)
		expect(Date.now() - started).toBeLessThan(BOUND_MS * 6)
	}, 30_000)

	it('refuses a disabling value on the public config', async () => {
		await expect(openWorkspace(0)).rejects.toThrow(/apiRequestTimeoutMs/)
	}, 30_000)
})
