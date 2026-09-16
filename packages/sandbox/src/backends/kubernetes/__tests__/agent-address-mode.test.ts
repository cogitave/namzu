/**
 * Which address the guest agent is dialed at — `agentAddress: 'service'`
 * (the default) versus `'pod-ip'`.
 *
 * The defect this suite exists for is invisible from inside the cluster. A
 * Service FQDN resolves through cluster DNS and nowhere else, so a host on a
 * peered VNet with a routable pod range fails every call at NAME RESOLUTION —
 * readiness and the privilege probe included, which is why the symptom is a
 * `create()` that rejects on its readiness budget and names a timeout rather
 * than the resolver. Nothing about the cluster is wrong, and nothing in the
 * old error says so.
 *
 * So three properties are held here, and the first is as important as the
 * other two: the DEFAULT still dials the FQDN, resolving it on every call,
 * with exactly the API traffic it made before. `'pod-ip'` is an addition, not
 * a migration.
 *
 * The DNS stubs are what make any of this observable. `recordLoopbackDns`
 * answers every name with a loopback address AND records the names, so
 * "dialed the FQDN" is the resolver's own account rather than an inference
 * from which socket answered — and `'pod-ip'`'s empty list is direct evidence
 * that `net.connect` never reached a resolver at all. `stubFailingDns` is the
 * only way to produce a real `ENOTFOUND`: a name the machine running this
 * suite genuinely cannot resolve is not a property anyone may assume of
 * somebody else's resolver.
 */

import { type AddressInfo, createServer, isIP } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createKubernetesWorkspace } from '../../../index.js'
import {
	type KubernetesAgentAddress,
	buildAgentAddressRefresh,
	buildKubernetesBackend,
	resolveAgentAddress,
} from '../index.js'
import { createKubernetesClient } from '../k8s-client.js'
import { KubernetesAgentAddressUnresolvableError, KubernetesAgentTransport } from '../transport.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	type RecordedRequest,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { recordLoopbackDns, stubFailingDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const SANDBOX_NAME = 'namzu-task-fixed'
const SERVICE_FQDN = `${SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`
const STATUS_POD_IP = '10.244.0.6'
/** The pod before it is replaced, and the pod after. Different uids. */
const FIRST_POD_UID = '11111111-1111-4111-8111-111111111111'
const SECOND_POD_UID = '22222222-2222-4222-8222-222222222222'
/**
 * Loopback stand-ins for two pod IPs. The scripted agent listens on
 * `0.0.0.0`, so an accepted connection's `localAddress` is the address the
 * CLIENT aimed at — which is how "it dialed the pod, not the Service" is
 * asserted without a second machine.
 */
const FIRST_POD_ADDRESS = '127.0.0.2'
const SECOND_POD_ADDRESS = '127.0.0.3'

const TEMPLATE = {
	metadata: { name: 'namzu-task', namespace: NAMESPACE },
	spec: {
		service: true,
		podTemplate: { spec: { containers: [{ name: 'main', image: 'namzu/agent:test' }] } },
	},
}

/** The block disk a workspace is refused without — see `workspace.ts`. */
const WORKSPACE_TEMPLATE = {
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
let dns: { readonly hostnames: readonly string[]; restore(): void } | undefined
/** Which pod the cluster is currently backed by. Flipped mid-test. */
let podUid: string
let podAddress: string
/** False between a `Suspended` patch and the `Running` one that undoes it. */
let podRunning: boolean
/**
 * How many more pod reads answer `Pending` with NO address — the window
 * between a pod being created and the CNI attaching it, which every real pod
 * passes through and the resume path deliberately binds inside of.
 * `POSITIVE_INFINITY` is a pod that never gets a network at all.
 */
let podReadsWithoutIP: number
/**
 * Fail every Sandbox GET made AFTER the first address-less pod answer — an
 * API-server fault landing in the middle of the wait for an address, which is
 * a different thing from a pod that never gets one and must not be reported
 * as one.
 */
let failSandboxReadsDuringTheAddressWait: boolean
let sawAddresslessPod: boolean

beforeEach(async () => {
	podUid = FIRST_POD_UID
	podAddress = FIRST_POD_ADDRESS
	podRunning = true
	podReadsWithoutIP = 0
	failSandboxReadsDuringTheAddressWait = false
	sawAddresslessPod = false
	agent = await startScriptedAgent({ host: '0.0.0.0', token: FIRST_POD_UID })
	dns = recordLoopbackDns()
	server = await startFakeApiServer(handleClusterRequest)
})

afterEach(async () => {
	dns?.restore()
	dns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

/**
 * A cluster with one sandbox. The pod GET carries BOTH addresses the backend
 * could take one from — `status.podIP` on the pod and `status.podIPs` on the
 * Sandbox — and they deliberately disagree, because taking the sandbox's is
 * the mistake: it can describe the pod a resume is replacing.
 */
function handleClusterRequest(req: RecordedRequest): FakeApiReply {
	if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
		return {
			status: 200,
			body: req.path.endsWith('namzu-workspace') ? WORKSPACE_TEMPLATE : TEMPLATE,
		}
	}
	if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
		return { status: 201, body: {} }
	}
	if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
		// A suspend takes the pod away and a resume brings one back. Nothing
		// else about the object moves — the Service FQDN and the Sandbox's own
		// status.podIPs stay exactly as they were, which is what makes the
		// pod GET the only honest source of the new address.
		const mode = (req.body as { spec?: { operatingMode?: string } }).spec?.operatingMode
		podRunning = mode !== 'Suspended'
		return { status: 200, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
		if (failSandboxReadsDuringTheAddressWait && sawAddresslessPod) {
			return { status: 500, body: { message: 'etcdserver: request timed out' } }
		}
		const name = req.path.split('/sandboxes/')[1]?.split('?')[0] ?? SANDBOX_NAME
		return {
			status: 200,
			body: {
				metadata: { name },
				// The mode the last PATCH left, not a constant: a resume reads
				// `spec.operatingMode` before it patches, so an object that
				// answered `Running` while its pod was suspended would make
				// every resume here look like one that woke nothing.
				spec: { operatingMode: podRunning ? 'Running' : 'Suspended' },
				status: {
					conditions: [readyCondition()],
					podIPs: [STATUS_POD_IP],
					serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local`,
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		if (!podRunning) return { status: 404, body: { message: 'gone' } }
		const name = req.path.split('/pods/')[1]?.split('?')[0] ?? SANDBOX_NAME
		// A pod exists, and is perfectly live, before it has an address: it is
		// `Pending` until the CNI attaches it. `isPodLive` accepts that on
		// purpose, so this is what the backend sees on the normal path.
		if (podReadsWithoutIP > 0) {
			podReadsWithoutIP -= 1
			sawAddresslessPod = true
			return {
				status: 200,
				body: { metadata: { name, uid: podUid }, status: { phase: 'Pending' } },
			}
		}
		return {
			status: 200,
			body: {
				metadata: { name, uid: podUid },
				status: { phase: 'Running', podIP: podAddress },
			},
		}
	}
	if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
	return { status: 404, body: { message: 'unexpected' } }
}

function backend(agentAddress?: 'service' | 'pod-ip') {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		...(agentAddress !== undefined ? { agentAddress } : {}),
	})
}

/** A `'pod-ip'` workspace against the fixture cluster. */
async function podIpWorkspace(readyTimeoutMs = 2_000) {
	if (!server || !agent) throw new Error('fixtures not started')
	return await createKubernetesWorkspace(
		{
			tier: 'microvm',
			service: 'kubernetes',
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-workspace',
			agentPort: agent.port,
			agentAddress: 'pod-ip',
			readyTimeoutMs,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		},
		{ workspaceId: 'addressed', workingDirectory: '/workspace' },
	)
}

/**
 * Every NAME the transport asked the resolver for.
 *
 * Literals are dropped: the API-server client is pointed at
 * `http://127.0.0.1:<port>` and that address goes through `dns.lookup` too,
 * which is noise here — the question is only ever which names were resolved.
 */
function resolvedNames(): string[] {
	if (!dns) throw new Error('fixtures not started')
	return dns.hostnames.filter((hostname) => isIP(hostname) === 0)
}

/** Method + path of every API request, with the client-owned name masked. */
function apiTrace(): string[] {
	if (!server) throw new Error('fixtures not started')
	return server.requests.map((r) => `${r.method} ${r.path.replace(/namzu-task-[0-9a-f-]+/, '<n>')}`)
}

/** A port nothing is listening on: opened, measured, closed. */
async function closedPort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((resolve) => probe.close(() => resolve()))
	return port
}

/** No retry budget: these cases are about the FIRST failed dial, not patience. */
const IMPATIENT = { connectTimeoutMs: 200, connectRetryBudgetMs: 0 } as const

describe('the default is unchanged', () => {
	it('dials the Service FQDN, and re-resolves it on every call', async () => {
		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		if (!agent) throw new Error('fixtures not started')

		// One name, resolved more than once — the transport dials fresh per
		// call and never remembers an address. The sandbox's own name is
		// client-generated, so the FQDN is matched by shape.
		const names = resolvedNames()
		expect(new Set(names).size).toBe(1)
		expect(names.length).toBeGreaterThan(1)
		expect(names[0]).toMatch(
			new RegExp(`^namzu-task-[0-9a-f-]+\\.${NAMESPACE}\\.svc\\.cluster\\.local$`),
		)
		// And the pod IP the pod GET carried was available, and not used.
		expect(agent.connections.every((c) => c.localAddress === '127.0.0.1')).toBe(true)
		await sandbox.destroy()
	})

	it('makes exactly the API requests it made before, in the same order', async () => {
		await (await backend().create({ workingDirectory: '/workspace' })).destroy()
		const withDefault = apiTrace()

		// A second acquire against the same fixture, with the mode named
		// explicitly. Same trace ⇒ the default IS 'service', rather than
		// something that merely happens to reach the same agent.
		if (!server) throw new Error('fixtures not started')
		const boundary = server.requests.length
		await (await backend('service').create({ workingDirectory: '/workspace' })).destroy()
		expect(apiTrace().slice(boundary)).toEqual(withDefault)
		expect(withDefault).toEqual([
			`GET /apis/extensions.agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxtemplates/namzu-task`,
			`POST /apis/agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxes`,
			`GET /apis/agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxes/<n>`,
			`GET /api/v1/namespaces/${NAMESPACE}/pods/<n>`,
			`DELETE /apis/agents.x-k8s.io/v1beta1/namespaces/${NAMESPACE}/sandboxes/<n>`,
		])
	})

	it('still prefers the Service FQDN over the Sandbox status pod IP', () => {
		expect(
			resolveAgentAddress(
				{ name: SANDBOX_NAME, podIPs: [STATUS_POD_IP], serviceFQDN: SERVICE_FQDN },
				1024,
				FIRST_POD_UID,
			),
		).toEqual({ kind: 'tcp', host: SERVICE_FQDN, port: 1024, token: FIRST_POD_UID })
	})
})

describe("agentAddress: 'pod-ip'", () => {
	it('dials the IP off the same pod GET the bind token came from', async () => {
		const sandbox = await backend('pod-ip').create({ workingDirectory: '/workspace' })
		if (!agent || !server) throw new Error('fixtures not started')

		// The pod's own address, not the Sandbox status's `10.244.0.6` — and
		// one pod GET, so the token and the address cannot describe two pods.
		expect(agent.connections.length).toBeGreaterThan(0)
		expect(agent.connections.every((c) => c.localAddress === FIRST_POD_ADDRESS)).toBe(true)
		expect(server.matching('GET', '/pods/')).toHaveLength(1)
		// No NAME was resolved at all: that is the entire point of the mode,
		// and it is why a host with no cluster DNS can use it.
		expect(resolvedNames()).toEqual([])
		expect(agent.requests.every((r) => r.token === undefined || r.token === FIRST_POD_UID)).toBe(
			true,
		)
		await sandbox.destroy()
	})

	it('refuses a pod that reports no IP rather than falling back to the Sandbox status', () => {
		expect(() =>
			resolveAgentAddress(
				{ name: SANDBOX_NAME, podIPs: [STATUS_POD_IP], serviceFQDN: SERVICE_FQDN },
				1024,
				FIRST_POD_UID,
				{ mode: 'pod-ip' },
			),
		).toThrow(/no status\.podIP/)
	})

	it('re-reads the live pod, so a replaced pod moves both the address and the token', async () => {
		if (!server) throw new Error('fixtures not started')
		const client = createKubernetesClient({
			server: server.url,
			namespace: NAMESPACE,
			getToken: async () => 'sa-token',
		})
		const refresh = buildAgentAddressRefresh(
			client,
			NAMESPACE,
			{ name: SANDBOX_NAME, serviceFQDN: SERVICE_FQDN },
			1024,
			'pod-ip',
		)

		expect(await refresh()).toEqual({
			kind: 'tcp',
			host: FIRST_POD_ADDRESS,
			port: 1024,
			token: FIRST_POD_UID,
		})
		podUid = SECOND_POD_UID
		podAddress = SECOND_POD_ADDRESS
		// Both facts move together, out of one read: an address from the new
		// pod with the old pod's token is refused by the guest as a flat
		// `unauthorized`, which is the failure this pairing prevents.
		expect(await refresh()).toEqual({
			kind: 'tcp',
			host: SECOND_POD_ADDRESS,
			port: 1024,
			token: SECOND_POD_UID,
		})
	})
})

describe('a pod that is live but has no address yet', () => {
	it('is waited out on acquire, not refused', async () => {
		podReadsWithoutIP = 3
		const sandbox = await backend('pod-ip').create({ workingDirectory: '/workspace' })
		if (!agent || !server) throw new Error('fixtures not started')

		// It kept reading the SAME pod until the address arrived, then dialed
		// that address — four reads for three address-less answers.
		expect(server.matching('GET', '/pods/')).toHaveLength(4)
		expect(agent.connections.length).toBeGreaterThan(0)
		expect(agent.connections.every((c) => c.localAddress === FIRST_POD_ADDRESS)).toBe(true)
		await sandbox.destroy()
	})

	it('is refused once the readiness budget is spent, not before it', async () => {
		podReadsWithoutIP = Number.POSITIVE_INFINITY
		const startedAt = Date.now()

		await expect(backend('pod-ip').create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/no status\.podIP/,
		)

		// The budget was SPENT waiting, rather than the refusal arriving
		// instantly with the whole of it unused: many reads, not one.
		expect(Date.now() - startedAt).toBeGreaterThan(500)
		expect(server?.matching('GET', '/pods/').length ?? 0).toBeGreaterThan(5)
	})

	it('is read exactly once under the default mode, which needs no address', async () => {
		// The same pod the case above times out on. `'service'` never looks
		// at `status.podIP`, so nothing about this path may wait for one.
		podReadsWithoutIP = Number.POSITIVE_INFINITY
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		expect(server?.matching('GET', '/pods/')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('reports an API failure during the wait instead of blaming the pod', async () => {
		// The wait polls the SANDBOX as well as the pod, and an API server
		// that fails mid-wait is not a pod the CNI never attached. Reporting
		// it as one is the same defect this whole change exists to remove: it
		// sends an operator to the pod's events for a fault that was never the
		// pod's, claims a readiness budget elapsed that had barely started,
		// and loses the 500 entirely.
		podReadsWithoutIP = Number.POSITIVE_INFINITY
		failSandboxReadsDuringTheAddressWait = true

		const error = await podIpWorkspace().then(
			() => undefined,
			(err: unknown) => err,
		)

		expect((error as Error | undefined)?.message).toContain('500')
		expect((error as Error).message).toContain('etcdserver')
		expect((error as Error).message).not.toContain('status.podIP')
	})
})

describe('a dial that fails at connect', () => {
	it('re-reads the pod exactly once, and follows it when the uid changed', async () => {
		if (!agent) throw new Error('fixtures not started')
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentAddress> => ({
				kind: 'tcp',
				host: SECOND_POD_ADDRESS,
				port: agent?.port ?? 0,
				token: SECOND_POD_UID,
			}),
		)
		agent.setToken(SECOND_POD_UID)
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: FIRST_POD_ADDRESS, port: await closedPort(), token: FIRST_POD_UID },
			{ ...IMPATIENT, refreshHandle },
		)

		// The call SUCCEEDS: the retry is safe precisely because the failure
		// was at connect, so nothing reached the guest to be repeated.
		const reservation = (await transport.reserve()) as { ok: boolean }
		expect(reservation.ok).toBe(true)
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		// The new address AND the new token, together.
		expect(agent.connections.map((c) => c.localAddress)).toEqual([SECOND_POD_ADDRESS])
		expect(agent.requests.map((r) => r.token)).toEqual([SECOND_POD_UID])
		expect(transport.address).toEqual({ host: SECOND_POD_ADDRESS, port: agent.port })
	})

	it('leaves the original error standing when the pod is unchanged', async () => {
		if (!agent) throw new Error('fixtures not started')
		// The re-read answers with the SAME uid at an address that WOULD
		// work. Adopting it is what must not happen: the uid is the whole
		// test, so a transport that followed any refreshed handle would
		// succeed here, and this case would pass a mutant that dropped the
		// uid-change check.
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentAddress> => ({
				kind: 'tcp',
				host: FIRST_POD_ADDRESS,
				port: agent?.port ?? 0,
				token: FIRST_POD_UID,
			}),
		)
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: FIRST_POD_ADDRESS, port: await closedPort(), token: FIRST_POD_UID },
			{ ...IMPATIENT, refreshHandle },
		)

		// Same uid ⇒ the pod was never replaced ⇒ this is the guest refusing
		// connections, and reporting it as anything else would hide that.
		await expect(transport.readFile('/etc/hostname')).rejects.toThrow(/could not connect to agent/)
		expect(refreshHandle).toHaveBeenCalledTimes(1)
		// Nothing was retried anywhere: the live agent was never dialed.
		expect(agent.connections).toHaveLength(0)
	})

	it('is not something the GUEST can claim by wording its answer that way', async () => {
		// "The failure came out of the dial" is what makes the retry safe, so
		// it is asked of the error's TYPE. A guest that answers with text —
		// a command's stderr, a path, its own upstream's failure — must not be
		// able to put this transport into a re-read by quoting the phrase the
		// dial's own message happens to use.
		const guest = await startScriptedAgent({
			token: FIRST_POD_UID,
			readFileError: 'read-file failed: could not connect to agent at 10.0.0.9:80',
		})
		const refreshHandle = vi.fn(
			async (): Promise<KubernetesAgentAddress> => ({
				kind: 'tcp',
				host: SECOND_POD_ADDRESS,
				port: guest.port,
				token: SECOND_POD_UID,
			}),
		)
		try {
			const transport = new KubernetesAgentTransport(
				// A pod-ip handle, so nothing else could explain a re-read: a
				// literal host never reaches the name-resolution branch.
				{ kind: 'tcp', host: '127.0.0.1', port: guest.port, token: FIRST_POD_UID },
				{ ...IMPATIENT, refreshHandle },
			)

			await expect(transport.readFile('/etc/hosts')).rejects.toThrow(/10\.0\.0\.9:80/)
			expect(refreshHandle).not.toHaveBeenCalled()
		} finally {
			await guest.close()
		}
	})

	it('re-reads once per call and not once per attempt', async () => {
		const port = await closedPort()
		// A pod that keeps being replaced would otherwise re-read forever.
		let uid = 0
		const refreshHandle = vi.fn(async (): Promise<KubernetesAgentAddress> => {
			uid += 1
			return { kind: 'tcp', host: FIRST_POD_ADDRESS, port, token: `uid-${uid}` }
		})
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: FIRST_POD_ADDRESS, port, token: FIRST_POD_UID },
			{ ...IMPATIENT, refreshHandle },
		)

		await expect(transport.readFile('/etc/hostname')).rejects.toThrow(/could not connect to agent/)
		expect(refreshHandle).toHaveBeenCalledTimes(1)
	})
})

describe('a Service FQDN that does not resolve', () => {
	it('names the FQDN and the option that fixes it', async () => {
		dns?.restore()
		const failing = stubFailingDns()
		const refreshHandle = vi.fn(async (): Promise<KubernetesAgentAddress> => {
			throw new Error('the pod must not be re-read for a name that does not resolve')
		})
		try {
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: SERVICE_FQDN, port: 1024, token: FIRST_POD_UID },
				{ ...IMPATIENT, refreshHandle },
			)
			// Not `healthz`: that one reports a failed dial as `false` rather
			// than throwing, so it carries no reason to name.
			const error = await transport.readFile('/etc/hostname').then(
				() => undefined,
				(err: unknown) => err,
			)

			expect(error).toBeInstanceOf(KubernetesAgentAddressUnresolvableError)
			expect((error as KubernetesAgentAddressUnresolvableError).host).toBe(SERVICE_FQDN)
			expect((error as Error).message).toContain(SERVICE_FQDN)
			expect((error as Error).message).toContain("agentAddress: 'pod-ip'")
			// The resolver, not the pod, is what failed: re-reading the pod
			// would ask the same resolver the same question.
			expect(refreshHandle).not.toHaveBeenCalled()
			expect(failing.hostnames).toContain(SERVICE_FQDN)
		} finally {
			failing.restore()
			dns = recordLoopbackDns()
		}
	})

	it('survives all the way out of create(), which is where a caller meets it', async () => {
		// The symptom the issue describes is a `create()` that rejects naming
		// a timeout. The first thing on that path to touch the guest is the
		// privilege probe, and what it reports is what the operator reads —
		// so the hint has to reach THERE, not merely exist in the transport.
		dns?.restore()
		const failing = stubFailingDns()
		const startedAt = Date.now()
		try {
			const error = await backend()
				.create({ workingDirectory: '/workspace' })
				.then(
					() => undefined,
					(err: unknown) => err,
				)

			// And it did not spend the dial's 30s retry budget getting there:
			// asking the same resolver the same question until the probe's own
			// 2s deadline expires is exactly how the diagnosis gets replaced
			// by a timeout.
			expect(Date.now() - startedAt).toBeLessThan(1_000)
			expect((error as Error | undefined)?.message).toMatch(
				new RegExp(`namzu-task-[0-9a-f-]+\\.${NAMESPACE}\\.svc\\.cluster\\.local`),
			)
			expect((error as Error).message).toContain("agentAddress: 'pod-ip'")
			expect(failing.hostnames.some((h) => h.endsWith('.svc.cluster.local'))).toBe(true)
		} finally {
			failing.restore()
			dns = recordLoopbackDns()
		}
	})

	it('spends the retry budget on a resolver that is merely UNAVAILABLE', async () => {
		// `EAI_AGAIN` is "temporary failure in name resolution": inside the
		// cluster it is a CoreDNS restart or a conntrack race, and the dial's
		// budget is exactly what rides over it. Giving up at once would turn a
		// blip every in-cluster caller used to survive into a failed call
		// carrying advice ("set agentAddress: 'pod-ip'") that is wrong for a
		// host whose Service FQDN is perfectly correct.
		dns?.restore()
		const unavailable = stubFailingDns('EAI_AGAIN')
		try {
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: SERVICE_FQDN, port: 1024, token: FIRST_POD_UID },
				{ connectTimeoutMs: 100, connectRetryBudgetMs: 300, connectRetryIntervalMs: 20 },
			)
			const startedAt = Date.now()
			const error = await transport.readFile('/etc/hostname').then(
				() => undefined,
				(err: unknown) => err,
			)

			// It waited — many lookups over the budget, not one and out.
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
			expect(unavailable.hostnames.filter((h) => h === SERVICE_FQDN).length).toBeGreaterThan(1)
			// And the diagnosis is delayed, not lost: a resolver still saying
			// this after the whole budget is one this host cannot use.
			expect(error).toBeInstanceOf(KubernetesAgentAddressUnresolvableError)
		} finally {
			unavailable.restore()
			dns = recordLoopbackDns()
		}
	})

	it('does not rewrite a failure the GUEST answered and merely worded that way', async () => {
		// Under the default mode the host is always a name, so this branch is
		// asked of every failure on the default path — and the evidence it
		// reads is a SUBSTRING, because the dial's retry wrapper does not
		// carry the resolver's `code` forward. A guest that reports a path, a
		// command's output or its own upstream fetch containing `ENOTFOUND`
		// must therefore not be turned into "your Service FQDN does not
		// resolve, set agentAddress: 'pod-ip'": the dial succeeded, and the
		// advice would be nonsense about a sandbox that is answering.
		const guest = await startScriptedAgent({
			readFileError: 'read-file failed: getaddrinfo ENOTFOUND registry.internal',
		})
		try {
			const transport = new KubernetesAgentTransport(
				{ kind: 'tcp', host: SERVICE_FQDN, port: guest.port, token: FIRST_POD_UID },
				IMPATIENT,
			)
			const error = await transport.readFile('/etc/hosts').then(
				() => undefined,
				(err: unknown) => err,
			)

			expect(error).not.toBeInstanceOf(KubernetesAgentAddressUnresolvableError)
			expect((error as Error | undefined)?.message).toContain('registry.internal')
			expect((error as Error).message).not.toContain("agentAddress: 'pod-ip'")
		} finally {
			await guest.close()
		}
	})
})

describe('a workspace resume', () => {
	it("re-reads the pod IP, so a 'pod-ip' session follows the new pod", async () => {
		if (!agent) throw new Error('fixtures not started')
		const workspace = await podIpWorkspace()
		expect(agent.connections.every((c) => c.localAddress === FIRST_POD_ADDRESS)).toBe(true)

		await workspace.suspend()
		// The pod the controller brings back is a new pod: new uid, new IP,
		// same name. Nothing about the Sandbox's own status changes.
		podUid = SECOND_POD_UID
		podAddress = SECOND_POD_ADDRESS
		agent.setToken(SECOND_POD_UID)
		const dialsBefore = agent.connections.length

		await workspace.resume()

		const afterResume = agent.connections.slice(dialsBefore)
		expect(afterResume.length).toBeGreaterThan(0)
		expect(afterResume.every((c) => c.localAddress === SECOND_POD_ADDRESS)).toBe(true)
		await workspace.destroy()
	})

	it('waits for the replacement pod to be given an address', async () => {
		if (!agent) throw new Error('fixtures not started')
		const workspace = await podIpWorkspace()

		await workspace.suspend()
		podUid = SECOND_POD_UID
		podAddress = SECOND_POD_ADDRESS
		agent.setToken(SECOND_POD_UID)
		// The replacement pod is bound while it is still `Pending` — that is
		// what excluding by uid means — so for its first polls it is a live
		// pod with no address. This is the ordinary case, not an exotic one:
		// refusing here would fail nearly every resume.
		podReadsWithoutIP = 3
		const dialsBefore = agent.connections.length

		await workspace.resume()

		const afterResume = agent.connections.slice(dialsBefore)
		expect(afterResume.length).toBeGreaterThan(0)
		expect(afterResume.every((c) => c.localAddress === SECOND_POD_ADDRESS)).toBe(true)
		await workspace.destroy()
	})

	it('refuses in the end, naming the pod that never got one', async () => {
		if (!agent) throw new Error('fixtures not started')
		// Long enough that a loaded machine cannot stall through the WHOLE
		// budget before the first pod read: the refusal names the pod it saw,
		// so a resume that never manages one read reports the other timeout.
		const workspace = await podIpWorkspace(1_500)

		await workspace.suspend()
		podUid = SECOND_POD_UID
		agent.setToken(SECOND_POD_UID)
		// A pod that is never given a network: the wait is bounded by the
		// readiness budget, and what it says is which fact never arrived.
		podReadsWithoutIP = Number.POSITIVE_INFINITY

		await expect(workspace.resume()).rejects.toThrow(
			new RegExp(`bound pod ${SECOND_POD_UID} that pod still reported no status\\.podIP`),
		)
		await workspace.destroy()
	})
})
