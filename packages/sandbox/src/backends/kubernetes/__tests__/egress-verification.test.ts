/**
 * Startup verification, end to end: `buildKubernetesBackend(...).create()`
 * against a real fake HTTP API server, with `config.egress` set.
 *
 * `egress-policy.test.ts` covers `translateEgressPolicy` and
 * `verifyEgressPolicyApplied` in isolation; this file is the "or the first
 * create()" half of the design — that the backend actually calls them,
 * exactly once, and that a missing or mismatched policy stops `create()`
 * before a sandbox is ever handed back.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildKubernetesBackend } from '../index.js'
import {
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const POOL_SANDBOX_NAME = 'egress-pool-sandbox-1'
const POD_UID = '5f2c9c9c-0e5d-4a2d-9e2a-19b1c0a8d002'

let server: FakeApiServer | undefined
// `create()` reaches the guest before it resolves — the acquire-time
// privilege probe — so these cases need a guest as well as an API server.
// It answers the probe with a correctly deprivileged /proc/self/status;
// what THIS file is about is what happens before the probe runs at all.
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

beforeEach(async () => {
	agent = await startScriptedAgent({ token: POD_UID })
	restoreDns = stubLoopbackDns()
})

afterEach(async () => {
	restoreDns?.()
	restoreDns = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

/** The exact spec a `deny-all` translation against `namzu-task` produces. */
const MATCHING_NETWORK_POLICY_SPEC = {
	podSelector: { matchLabels: { 'sandbox.namzu.ai/template': 'namzu-task' } },
	policyTypes: ['Egress'],
	egress: [
		{
			to: [
				{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
			],
			ports: [
				{ protocol: 'UDP', port: 53 },
				{ protocol: 'TCP', port: 53 },
			],
		},
	],
}

function handleWarmAcquire(req: { method: string; path: string }):
	| { status: number; body: unknown }
	| undefined {
	if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
		return { status: 201, body: {} }
	}
	if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
		return {
			status: 200,
			body: {
				status: {
					conditions: [readyCondition()],
					sandbox: {
						name: POOL_SANDBOX_NAME,
						serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
					},
				},
			},
		}
	}
	if (req.method === 'GET' && req.path.includes('/pods/')) {
		return { status: 200, body: { metadata: { uid: POD_UID } } }
	}
	if (req.method === 'DELETE') return { status: 200, body: {} }
	return undefined
}

function backend() {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		egress: { policy: { kind: 'deny-all' } },
	})
}

describe('verify-not-trust, against a real fake API server', () => {
	it('create() succeeds when the applied NetworkPolicy matches the translation', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: { spec: MATCHING_NETWORK_POLICY_SPEC } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies/')).toHaveLength(1)
		await sandbox.destroy()
	})

	it('names the exact NetworkPolicy path it expects, derived from the template name', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: { spec: MATCHING_NETWORK_POLICY_SPEC } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		await (await backend().create({ workingDirectory: '/workspace' })).destroy()
		expect(server.matching('GET', '/networkpolicies/namzu-task-egress')).toHaveLength(1)
	})

	it('runs the check exactly once across two creates, not once per create', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 200, body: { spec: MATCHING_NETWORK_POLICY_SPEC } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		const provider = backend()
		const first = await provider.create({ workingDirectory: '/workspace' })
		const second = await provider.create({ workingDirectory: '/workspace' })
		expect(server.matching('GET', '/networkpolicies/')).toHaveLength(1)
		await first.destroy()
		await second.destroy()
	})

	it('fails, naming the fix, when no NetworkPolicy is applied at all (404)', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return { status: 404, body: { message: 'not found' } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/never creates the egress policy itself/,
		)
		// Never claims a sandbox for a policy it could not verify.
		expect(server.matching('POST', '/sandboxclaims')).toHaveLength(0)
	})

	it('fails, naming the field, when the applied NetworkPolicy has drifted from config', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				return {
					status: 200,
					body: {
						spec: {
							...MATCHING_NETWORK_POLICY_SPEC,
							podSelector: { matchLabels: { app: 'something-else' } },
						},
					},
				}
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/spec\.podSelector/,
		)
		expect(server.matching('POST', '/sandboxclaims')).toHaveLength(0)
	})

	it('retries verification on the next create() after a failed attempt, rather than wedging forever', async () => {
		let networkPolicyCalls = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
				networkPolicyCalls += 1
				if (networkPolicyCalls === 1) return { status: 404, body: {} }
				return { status: 200, body: { spec: MATCHING_NETWORK_POLICY_SPEC } }
			}
			return handleWarmAcquire(req) ?? { status: 404, body: {} }
		})

		const provider = backend()
		await expect(provider.create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/never creates the egress policy itself/,
		)
		const sandbox = await provider.create({ workingDirectory: '/workspace' })
		expect(networkPolicyCalls).toBe(2)
		await sandbox.destroy()
	})

	it('never GETs a NetworkPolicy at all when config.egress is unset', async () => {
		server = await startFakeApiServer((req) => handleWarmAcquire(req) ?? { status: 404, body: {} })

		const sandbox = await buildKubernetesBackend({
			access: { server: server.url, getToken: async () => 'sa-token' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-task',
			warmPoolName: 'namzu-task-pool',
			agentPort: agent?.port ?? 0,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
		}).create({ workingDirectory: '/workspace' })

		expect(server.matching('GET', '/networkpolicies/')).toHaveLength(0)
		await sandbox.destroy()
	})
})
