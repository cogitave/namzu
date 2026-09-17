/**
 * #497 — a host-supplied identity on the claim body (`claimLabels`),
 * recovering a crashed host's claims by that label
 * (`releaseKubernetesTaskSandboxes`), and reading warm-pool headroom before
 * admitting more work (`readKubernetesTaskCapacity`).
 *
 * Every SHAPE is provable here, against a fake API server: the body carries
 * the labels and nothing else moved, an empty selector is refused before a
 * single request, a release DELETEs exactly the names its own LIST
 * returned, and a capacity read maps three GETs into one record — including
 * a burst of many claims and pods, which is the one thing this file can
 * fabricate that a real cluster has to be trusted for elsewhere. What this
 * file cannot prove is the real agent-sandbox controller's own counts and
 * its garbage collection on DELETE — see this workstream's kind run notes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	type KubernetesBackendInternalConfig,
	buildKubernetesBackend,
	readKubernetesTaskCapacity,
	releaseKubernetesTaskSandboxes,
} from '../index.js'
import {
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const POD_UID = '5f2c9c9c-0e5d-4a2d-9e2a-19b1c0a8d100'
const POOL_SANDBOX_NAME = 'claim-labels-pool-sandbox-1'
const HOST_LABEL_KEY = 'sandbox.namzu.ai/host-instance'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

function baseConfig(
	extra: Partial<KubernetesBackendInternalConfig> = {},
): KubernetesBackendInternalConfig {
	if (!server) throw new Error('fixtures not started')
	return {
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		// This suite's fake API server never serves a networkpolicies
		// collection, and none of these tests are about the ingress check
		// (#488) — the three that go through a real acquire opt out of it the
		// same way every other pre-existing acquire fixture in this directory
		// does, rather than fabricating a policy that would prove nothing here.
		ingress: 'unverified' as const,
		...extra,
	}
}

describe('claimLabels on the claim body', () => {
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

	it('carries the configured labels, and nothing else about the body moved', async () => {
		server = await startFakeApiServer((req) => handleWarmAcquire(req) ?? { status: 404, body: {} })
		if (!agent) throw new Error('agent not started')
		const backend = buildKubernetesBackend(
			baseConfig({
				agentPort: agent.port,
				readyTimeoutMs: 2_000,
				readyPollIntervalMs: 5,
				claimLabels: { [HOST_LABEL_KEY]: 'host-a' },
			}),
		)
		const sandbox = await backend.create({ workingDirectory: '/workspace' })
		const posted = server.matching('POST', '/sandboxclaims')
		expect(posted).toHaveLength(1)
		const body = posted[0]?.body as Record<string, unknown>
		const metadata = body.metadata as Record<string, unknown>
		expect(metadata.labels).toEqual({ [HOST_LABEL_KEY]: 'host-a' })
		expect(body.spec).toEqual({
			warmPoolRef: { name: 'namzu-task-pool' },
			lifecycle: { shutdownTime: expect.any(String), shutdownPolicy: 'Delete' },
		})
		await sandbox.destroy()
	})

	it('a host setting no claimLabels sends exactly the baseline body', async () => {
		server = await startFakeApiServer((req) => handleWarmAcquire(req) ?? { status: 404, body: {} })
		if (!agent) throw new Error('agent not started')
		const backend = buildKubernetesBackend(
			baseConfig({ agentPort: agent.port, readyTimeoutMs: 2_000, readyPollIntervalMs: 5 }),
		)
		const sandbox = await backend.create({ workingDirectory: '/workspace' })
		const posted = server.matching('POST', '/sandboxclaims')
		const metadata = (posted[0]?.body as Record<string, unknown>).metadata as Record<
			string,
			unknown
		>
		expect(metadata.labels).toBeUndefined()
		expect(Object.keys(metadata).sort()).toEqual(['name', 'namespace'])
		await sandbox.destroy()
	})

	it('an empty claimLabels bag is treated as no labels at all', async () => {
		server = await startFakeApiServer((req) => handleWarmAcquire(req) ?? { status: 404, body: {} })
		if (!agent) throw new Error('agent not started')
		const backend = buildKubernetesBackend(
			baseConfig({
				agentPort: agent.port,
				readyTimeoutMs: 2_000,
				readyPollIntervalMs: 5,
				claimLabels: {},
			}),
		)
		const sandbox = await backend.create({ workingDirectory: '/workspace' })
		const posted = server.matching('POST', '/sandboxclaims')
		const metadata = (posted[0]?.body as Record<string, unknown>).metadata as Record<
			string,
			unknown
		>
		expect(metadata.labels).toBeUndefined()
		await sandbox.destroy()
	})
})

describe('releaseKubernetesTaskSandboxes', () => {
	afterEach(async () => {
		await server?.close()
		server = undefined
	})

	it('refuses an empty labelSelector before a single request', async () => {
		server = await startFakeApiServer(() => ({ status: 500, body: {} }))
		await expect(
			releaseKubernetesTaskSandboxes(baseConfig(), { labelSelector: '' }),
		).rejects.toThrow(/non-empty labelSelector/)
		expect(server.requests).toHaveLength(0)
	})

	it('LISTs by the selector and DELETEs exactly the names the LIST returned', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxclaims?')) {
				return {
					status: 200,
					body: {
						items: [{ metadata: { name: 'namzu-task-a' } }, { metadata: { name: 'namzu-task-b' } }],
					},
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})
		const result = await releaseKubernetesTaskSandboxes(baseConfig(), {
			labelSelector: `${HOST_LABEL_KEY}=host-a`,
		})
		expect(result).toEqual({ deleted: 2, names: ['namzu-task-a', 'namzu-task-b'] })
		const listReqs = server.matching('GET', '/sandboxclaims?')
		expect(listReqs).toHaveLength(1)
		expect(listReqs[0]?.path).toContain(encodeURIComponent(`${HOST_LABEL_KEY}=host-a`))
		const deletes = server.matching('DELETE', '/sandboxclaims/')
		expect(
			deletes.map((r) => r.path.endsWith('namzu-task-a') || r.path.endsWith('namzu-task-b')),
		).toEqual([true, true])
	})

	it('a claim already gone (404) still counts as released', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxclaims?')) {
				return { status: 200, body: { items: [{ metadata: { name: 'namzu-task-a' } }] } }
			}
			if (req.method === 'DELETE') return { status: 404, body: {} }
			return { status: 404, body: {} }
		})
		const result = await releaseKubernetesTaskSandboxes(baseConfig(), { labelSelector: 'x=y' })
		expect(result).toEqual({ deleted: 1, names: ['namzu-task-a'] })
	})

	it('an empty LIST releases nothing and DELETEs nothing', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxclaims?')) {
				return { status: 200, body: { items: [] } }
			}
			return { status: 500, body: {} }
		})
		const result = await releaseKubernetesTaskSandboxes(baseConfig(), { labelSelector: 'x=y' })
		expect(result).toEqual({ deleted: 0, names: [] })
		expect(server.matching('DELETE', '/sandboxclaims/')).toHaveLength(0)
	})
})

describe('readKubernetesTaskCapacity', () => {
	afterEach(async () => {
		await server?.close()
		server = undefined
	})

	it('requires config.warmPoolName', async () => {
		server = await startFakeApiServer(() => ({ status: 500, body: {} }))
		await expect(
			readKubernetesTaskCapacity({
				access: { server: server.url, getToken: async () => 't' },
				namespace: NAMESPACE,
				sandboxTemplateName: 'namzu-task',
			}),
		).rejects.toThrow(/requires config\.warmPoolName/)
		expect(server.requests).toHaveLength(0)
	})

	it('maps three reads into one record: warm pool, claims bound to it, and pending pods', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxwarmpools/')) {
				return { status: 200, body: { spec: { replicas: 3 }, status: { readyReplicas: 2 } } }
			}
			if (req.method === 'GET' && req.path.endsWith('/sandboxclaims')) {
				return {
					status: 200,
					body: {
						items: [
							{ spec: { warmPoolRef: { name: 'namzu-task-pool' } } },
							{ spec: { warmPoolRef: { name: 'namzu-task-pool' } } },
							// A claim against a DIFFERENT pool in the same namespace does
							// not count toward this pool's headroom.
							{ spec: { warmPoolRef: { name: 'other-pool' } } },
						],
					},
				}
			}
			if (req.method === 'GET' && req.path.endsWith('/pods')) {
				return {
					status: 200,
					body: {
						items: [
							{ status: { phase: 'Running' } },
							{ status: { phase: 'Pending' } },
							{ status: { phase: 'Pending' } },
						],
					},
				}
			}
			return { status: 404, body: {} }
		})
		const capacity = await readKubernetesTaskCapacity(baseConfig())
		expect(capacity).toEqual({
			warmPool: { ready: 2, desired: 3 },
			activeClaims: 2,
			pendingPods: 2,
		})
	})

	it('a burst of many claims and pods is reflected exactly — three reads, no writes', async () => {
		const claimCount = 25
		const pendingPodCount = 9
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxwarmpools/')) {
				return { status: 200, body: { spec: { replicas: 5 }, status: { readyReplicas: 5 } } }
			}
			if (req.method === 'GET' && req.path.endsWith('/sandboxclaims')) {
				return {
					status: 200,
					body: {
						items: Array.from({ length: claimCount }, (_, i) => ({
							metadata: { name: `namzu-task-${i}` },
							spec: { warmPoolRef: { name: 'namzu-task-pool' } },
						})),
					},
				}
			}
			if (req.method === 'GET' && req.path.endsWith('/pods')) {
				return {
					status: 200,
					body: {
						items: [
							...Array.from({ length: 5 }, () => ({ status: { phase: 'Running' } })),
							...Array.from({ length: pendingPodCount }, () => ({
								status: { phase: 'Pending' },
							})),
						],
					},
				}
			}
			return { status: 404, body: {} }
		})
		const capacity = await readKubernetesTaskCapacity(baseConfig())
		expect(capacity.warmPool).toEqual({ ready: 5, desired: 5 })
		expect(capacity.activeClaims).toBe(claimCount)
		expect(capacity.pendingPods).toBe(pendingPodCount)
		// Exactly three reads: the pool, the claims collection, the pods
		// collection — no writes, and no per-item request.
		expect(server.requests).toHaveLength(3)
		expect(server.requests.every((r) => r.method === 'GET')).toBe(true)
	})

	it('an absent readyReplicas or replicas reads as 0, not undefined or a throw', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxwarmpools/')) {
				return { status: 200, body: { spec: {}, status: {} } }
			}
			if (req.method === 'GET' && req.path.endsWith('/sandboxclaims')) {
				return { status: 200, body: { items: [] } }
			}
			if (req.method === 'GET' && req.path.endsWith('/pods')) {
				return { status: 200, body: { items: [] } }
			}
			return { status: 404, body: {} }
		})
		const capacity = await readKubernetesTaskCapacity(baseConfig())
		expect(capacity).toEqual({
			warmPool: { ready: 0, desired: 0 },
			activeClaims: 0,
			pendingPods: 0,
		})
	})
})
