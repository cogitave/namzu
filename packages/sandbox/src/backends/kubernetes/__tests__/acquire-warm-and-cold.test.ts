/**
 * What acquire must get right, against a real HTTP API server.
 *
 * Two of these are regression tests for defects that do not fail loudly:
 *
 *  - A claim that carries `spec.env` or `spec.volumeClaimTemplates` is forced
 *    to cold-start upstream instead of adopting a warm pool sandbox. It still
 *    works. It just stops being fast, which no functional test can see, so the
 *    absence of those keys is asserted on the wire.
 *  - An adopted pool sandbox keeps the generated name the POOL gave it, not
 *    the claim's. A backend that assumed the claim's name would address the
 *    right pod on every cold start and the wrong one on every warm bind — and
 *    warm is the path that runs in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	DEFAULT_AGENT_PORT,
	acquireKubernetesSandbox,
	buildKubernetesBackend,
	resolveAgentAddress,
} from '../index.js'
import { createKubernetesClient } from '../k8s-client.js'
import {
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import { stubLoopbackDns } from './fixtures/loopback-dns.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const POOL_SANDBOX_NAME = 'smoke-pool-sandbox-7fb2c'
const POD_UID = '5f2c9c9c-0e5d-4a2d-9e2a-19b1c0a8d001'

let server: FakeApiServer | undefined
// `create()` reaches the guest agent before it resolves, for the
// acquire-time privilege probe, so these cases need a data plane as well as
// a control plane. The scripted guest answers the probe with a correctly
// deprivileged /proc/self/status — `privilege-probe.test.ts` owns what
// happens when it does not — and the DNS stub lets the fixtures keep
// describing sandboxes the way a cluster does, with real Service FQDNs,
// instead of rewriting every one of them to a loopback literal.
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

function backend(overrides: { warmPoolName?: string } = {}) {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
		...overrides,
	})
}

/** The template a pool-less create copies a podTemplate out of. */
const TEMPLATE_REPLY = {
	metadata: { name: 'namzu-task', namespace: NAMESPACE },
	spec: {
		service: true,
		podTemplate: {
			spec: {
				containers: [{ name: 'main', image: 'namzu/agent:test' }],
			},
		},
	},
}

describe('warm acquire, against a claim the pool adopts', () => {
	it('surfaces the bound sandbox, not the claim it was asked for', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST' && req.path.endsWith('/sandboxclaims')) {
				return { status: 201, body: { metadata: { name: 'ignored' } } }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: {
								name: POOL_SANDBOX_NAME,
								podIPs: ['10.244.0.6'],
								serviceFQDN: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
							},
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { name: POOL_SANDBOX_NAME, uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: { kind: 'Status' } }
			return { status: 404, body: { message: 'unexpected' } }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})

		// The claim was POSTed under a client-owned name; the id is the
		// SANDBOX's own name, which the pool generated and nothing here chose.
		const claimPost = server.matching('POST', '/sandboxclaims')[0]
		const claimName = (claimPost?.body as { metadata: { name: string } }).metadata.name
		expect(claimName).toMatch(/^namzu-task-/)
		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		expect(sandbox.id).not.toBe(claimName)
		// The pod GET follows the SANDBOX's name too — addressing the claim
		// would 404 against a pool-adopted sandbox.
		expect(server.matching('GET', '/pods/')[0]?.path).toContain(POOL_SANDBOX_NAME)
		await sandbox.destroy()
	})

	it('posts a pristine claim: a pool ref, a lifetime bound, and nothing else', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		const body = server.matching('POST', '/sandboxclaims')[0]?.body as {
			apiVersion: string
			kind: string
			spec: Record<string, unknown>
		}

		expect(body.apiVersion).toBe('extensions.agents.x-k8s.io/v1beta1')
		expect(body.kind).toBe('SandboxClaim')
		expect(body.spec.warmPoolRef).toEqual({ name: 'namzu-task-pool' })
		// The cold-start trap. Either key present makes the claim refuse to
		// adopt a warm sandbox, and the only symptom is latency.
		expect(Object.keys(body.spec).sort()).toEqual(['lifecycle', 'warmPoolRef'])
		expect(body.spec).not.toHaveProperty('env')
		expect(body.spec).not.toHaveProperty('volumeClaimTemplates')
		await sandbox.destroy()
	})

	it('bounds every claim by the wall clock so a dead host cannot leak one', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const before = Date.now()
		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		const lifecycle = (
			server.matching('POST', '/sandboxclaims')[0]?.body as {
				spec: { lifecycle: { shutdownTime: string; shutdownPolicy: string } }
			}
		).spec.lifecycle

		// `shutdownTime` and not `ttlSecondsAfterFinished`: upstream starts the
		// TTL timer from the Finished condition, which a host that crashed
		// mid-run never reaches, so only the absolute time bounds the leak.
		const shutdownAt = Date.parse(lifecycle.shutdownTime)
		expect(Number.isNaN(shutdownAt)).toBe(false)
		expect(shutdownAt).toBeGreaterThanOrEqual(before + 3_600_000 - 5_000)
		expect(shutdownAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000)
		// Retain (the CRD default) would leave the claim object behind forever.
		expect(lifecycle.shutdownPolicy).toBe('Delete')
		await sandbox.destroy()
	})

	it('honours a caller-chosen lifetime', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const before = Date.now()
		const sandbox = await buildKubernetesBackend({
			access: { server: server.url, getToken: async () => 't' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-task',
			warmPoolName: 'namzu-task-pool',
			claimTtlSeconds: 120,
			agentPort: agent?.port ?? 0,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		}).create({ workingDirectory: '/workspace' })

		const shutdownAt = Date.parse(
			(
				server.matching('POST', '/sandboxclaims')[0]?.body as {
					spec: { lifecycle: { shutdownTime: string } }
				}
			).spec.lifecycle.shutdownTime,
		)
		expect(shutdownAt).toBeGreaterThanOrEqual(before + 115_000)
		expect(shutdownAt).toBeLessThanOrEqual(Date.now() + 125_000)
		await sandbox.destroy()
	})

	it('reads the pod uid the transport will present as its bind token', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		// Exactly one pod read, and it is a GET: the acquire path never patches
		// the claim to plant a credential, because a mutated claim cold-starts.
		expect(server.matching('GET', '/pods/')).toHaveLength(1)
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		await sandbox.destroy()
	})

	it('falls back to the status selector when no pod carries the sandbox name', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			// The pod-name convention is an observation of v1.0.2, not an API
			// guarantee, so a 404 here must not end the acquire.
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 404, body: { message: 'not found' } }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				return {
					status: 200,
					body: { status: { selector: 'agents.x-k8s.io/sandbox-name-hash=abc123' } },
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods?')) {
				return { status: 200, body: { items: [{ metadata: { uid: POD_UID } }] } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		expect(server.matching('GET', '/pods?')[0]?.path).toContain(
			encodeURIComponent('agents.x-k8s.io/sandbox-name-hash=abc123'),
		)
		expect(sandbox.id).toBe(POOL_SANDBOX_NAME)
		await sandbox.destroy()
	})

	it('refuses a sandbox whose pod uid it cannot read rather than returning it unauthenticated', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: { message: 'not found' } }
		})

		await expect(
			backend({ warmPoolName: 'namzu-task-pool' }).create({ workingDirectory: '/workspace' }),
		).rejects.toThrow(/could not read a pod uid/)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('cold acquire, with no pool configured', () => {
	function coldServer(): Promise<FakeApiServer> {
		return startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: TEMPLATE_REPLY }
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
				return { status: 201, body: {} }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				const name = req.path.split('/sandboxes/')[1] ?? ''
				return {
					status: 200,
					body: {
						metadata: { name },
						status: {
							conditions: [readyCondition()],
							podIPs: ['10.244.0.9'],
							serviceFQDN: `${name}.${NAMESPACE}.svc.cluster.local`,
							selector: 'agents.x-k8s.io/sandbox-name-hash=cold',
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})
	}

	it('creates a Sandbox directly, because a pool-less claim does not exist', async () => {
		server = await coldServer()
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		expect(server.matching('POST', '/sandboxclaims')).toHaveLength(0)
		const body = server.matching('POST', '/sandboxes')[0]?.body as {
			apiVersion: string
			kind: string
			spec: {
				operatingMode: string
				service: boolean
				shutdownPolicy: string
				shutdownTime: string
				podTemplate: { spec: { containers: unknown[] } }
			}
		}
		expect(body.apiVersion).toBe('agents.x-k8s.io/v1beta1')
		expect(body.kind).toBe('Sandbox')
		expect(body.spec.operatingMode).toBe('Running')
		// Forced: without a Service there is no serviceFQDN, and the only
		// address left is a pod IP that changes on every resume.
		expect(body.spec.service).toBe(true)
		expect(body.spec.shutdownPolicy).toBe('Delete')
		expect(Date.parse(body.spec.shutdownTime)).toBeGreaterThan(Date.now())
		// Sandbox.spec has no templateRef, so the podTemplate is carried across
		// by the client from the named SandboxTemplate.
		expect(body.spec.podTemplate.spec.containers).toEqual([
			{ name: 'main', image: 'namzu/agent:test' },
		])
		await sandbox.destroy()
	})

	it('hands the caller the same id and address shape the warm path does', async () => {
		server = await coldServer()
		const cold = await backend().create({ workingDirectory: '/workspace' })
		expect(typeof cold.id).toBe('string')
		expect(cold.id).toMatch(/^namzu-task-/)
		expect(cold.status).toBe('ready')
		expect(cold.rootDir).toBe('/workspace')
		expect(cold.environment).toBe('linux-namespace')
		await cold.destroy()
		await server.close()

		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
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
			return { status: 404, body: {} }
		})
		const warm = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		expect(typeof warm.id).toBe('string')
		expect(warm.status).toBe('ready')
		expect(warm.rootDir).toBe(cold.rootDir)
		expect(warm.environment).toBe(cold.environment)
		await warm.destroy()
	})

	it('labels the pod template with the template name, since a direct Sandbox is never adopted', async () => {
		// agent-sandbox's own controller-owned
		// `agents.x-k8s.io/sandbox-template-ref-hash` label is written only on
		// bind out of a pool. A Sandbox this backend POSTs directly is never
		// adopted, so without a label of its own a translated NetworkPolicy's
		// podSelector (see `egress-policy.ts`) would have nothing to match it
		// by.
		server = await coldServer()
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		const body = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: { podTemplate: { metadata?: { labels?: Record<string, string> } } }
		}
		expect(body.spec.podTemplate.metadata?.labels).toEqual({
			'sandbox.namzu.ai/template': 'namzu-task',
		})
		await sandbox.destroy()
	})

	it('preserves labels already on the copied template, alongside its own', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return {
					status: 200,
					body: {
						metadata: { name: 'namzu-task', namespace: NAMESPACE },
						spec: {
							service: true,
							podTemplate: {
								metadata: { labels: { team: 'agents' } },
								spec: { containers: [{ name: 'main', image: 'namzu/agent:test' }] },
							},
						},
					},
				}
			}
			if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
				return { status: 201, body: {} }
			}
			if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
				const name = req.path.split('/sandboxes/')[1] ?? ''
				return {
					status: 200,
					body: {
						metadata: { name },
						status: { conditions: [readyCondition()], serviceFQDN: `${name}.ns.svc` },
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		const body = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: { podTemplate: { metadata?: { labels?: Record<string, string> } } }
		}
		expect(body.spec.podTemplate.metadata?.labels).toEqual({
			team: 'agents',
			'sandbox.namzu.ai/template': 'namzu-task',
		})
		await sandbox.destroy()
	})

	it('applies a runtime class it was given, because this path builds the pod spec', async () => {
		server = await coldServer()
		const sandbox = await buildKubernetesBackend({
			access: { server: server.url, getToken: async () => 't' },
			namespace: NAMESPACE,
			sandboxTemplateName: 'namzu-task',
			runtimeClassName: 'kata-qemu',
			agentPort: agent?.port ?? 0,
			readyTimeoutMs: 2_000,
			readyPollIntervalMs: 5,
			ingress: 'unverified' as const,
		}).create({ workingDirectory: '/workspace' })

		const body = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: { podTemplate: { spec: { runtimeClassName: string; containers: unknown[] } } }
		}
		expect(body.spec.podTemplate.spec.runtimeClassName).toBe('kata-qemu')
		expect(body.spec.podTemplate.spec.containers).toHaveLength(1)
		await sandbox.destroy()
	})

	it('refuses a template with no pod spec, before it creates anything', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
				return { status: 200, body: { metadata: { name: 'namzu-task' }, spec: {} } }
			}
			return { status: 404, body: {} }
		})

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/carries no spec\.podTemplate\.spec/,
		)
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})
})

describe('teardown', () => {
	it('deletes the claim it created, which cascades to the sandbox it adopted', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		await sandbox.destroy()

		const deletes = server.requests.filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toContain('/sandboxclaims/')
		expect(sandbox.status).toBe('destroyed')
		// A second destroy is a no-op, not a second DELETE.
		await sandbox.destroy()
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('treats an already-deleted object as successfully released', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: { name: POOL_SANDBOX_NAME, serviceFQDN: 'sbx.ns.svc.cluster.local' },
						},
					},
				}
			}
			if (req.method === 'GET' && req.path.includes('/pods/')) {
				return { status: 200, body: { metadata: { uid: POD_UID } } }
			}
			// Someone else reaped it — the TTL, an operator, the controller.
			if (req.method === 'DELETE') return { status: 404, body: { message: 'gone' } }
			return { status: 404, body: {} }
		})

		const sandbox = await backend({ warmPoolName: 'namzu-task-pool' }).create({
			workingDirectory: '/workspace',
		})
		await expect(sandbox.destroy()).resolves.toBeUndefined()
		expect(sandbox.status).toBe('destroyed')
	})
})

describe('the address the transport will dial', () => {
	it('prefers the Service FQDN, because a resumed pod has a new IP', () => {
		expect(
			resolveAgentAddress(
				{ name: 's', podIPs: ['10.244.0.6'], serviceFQDN: 's.ns.svc.cluster.local' },
				1024,
				'tok',
			),
		).toEqual({ kind: 'tcp', host: 's.ns.svc.cluster.local', port: 1024, token: 'tok' })
	})

	it('falls back to a pod IP when the sandbox has no Service', () => {
		expect(resolveAgentAddress({ name: 's', podIPs: ['10.244.0.6'] }, 2048, 'tok').host).toBe(
			'10.244.0.6',
		)
	})

	it('refuses a Ready sandbox with no address at all', () => {
		expect(() => resolveAgentAddress({ name: 's' }, 1024, 'tok')).toThrow(
			/neither a serviceFQDN nor a pod IP/,
		)
	})

	it('carries the pod uid and the agent port out of a real acquire', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return {
					status: 200,
					body: {
						status: {
							conditions: [readyCondition()],
							sandbox: {
								name: POOL_SANDBOX_NAME,
								podIPs: ['10.244.0.6'],
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
			return { status: 404, body: {} }
		})

		const client = createKubernetesClient({
			server: server.url,
			namespace: NAMESPACE,
			getToken: async () => 'sa-token',
		})
		const acquisition = await acquireKubernetesSandbox(
			client,
			{
				access: { server: server.url, getToken: async () => 'sa-token' },
				namespace: NAMESPACE,
				sandboxTemplateName: 'namzu-task',
				warmPoolName: 'namzu-task-pool',
				ingress: 'unverified' as const,
			},
			{ workingDirectory: '/workspace' },
			{ timeoutMs: 2_000, pollIntervalMs: 5 },
		)

		expect(acquisition.agent).toEqual({
			kind: 'tcp',
			host: `${POOL_SANDBOX_NAME}.${NAMESPACE}.svc.cluster.local`,
			port: DEFAULT_AGENT_PORT,
			token: POD_UID,
		})
		expect(acquisition.binding.name).toBe(POOL_SANDBOX_NAME)
		expect(acquisition.ownedPath).toContain('/sandboxclaims/')
		await acquisition.release()
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})
