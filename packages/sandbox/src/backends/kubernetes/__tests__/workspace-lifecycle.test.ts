/**
 * What a workspace must get right the first time, against a real HTTP API
 * server and a loopback agent.
 *
 * Most of these guard configurations that WORK and then disappoint, which is
 * the whole reason they are assertions rather than comments:
 *
 *  - A Sandbox POSTed without the template's `volumeClaimTemplates` comes up
 *    healthy and loses the caller's files on the first suspend. That defect
 *    shipped on the task path (a pool-less create dropped them), so the
 *    regression is asserted here for both paths.
 *  - A `Filesystem` disk on a VM-isolating RuntimeClass keeps every file and
 *    is several times slower at small-file IO. Nothing fails; the workspace is
 *    just slow, which no functional test can see.
 *  - `destroy()` defaulting to a DELETE would erase a month of a caller's work
 *    from a `finally` block. The default is asserted, not assumed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
	KubernetesWorkspaceDiskError,
	KubernetesWorkspaceMismatchError,
	KubernetesWorkspaceSuspendedError,
	createKubernetesWorkspace,
	workspaceSandboxName,
} from '../workspace.js'

import {
	KubernetesEgressPolicyNotAppliedError,
	KubernetesUnenforceableEgressPolicyError,
} from '../egress-policy.js'
import { buildKubernetesBackend } from '../index.js'
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
const WORKSPACE_ID = 'acme-checkout-7'
const WORKSPACE_NAME = 'namzu-ws-acme-checkout-7'
const POD_UID = '9c1f0b7e-5a44-4c3b-8f21-0c2a55d11a10'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let restoreDns: (() => void) | undefined

beforeEach(async () => {
	// `createKubernetesWorkspace` reaches the guest before it resolves, for
	// the same privilege probe every task acquire runs, so these cases need a
	// data plane as well as a control plane.
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

function config(overrides: Record<string, unknown> = {}) {
	if (!server || !agent) throw new Error('fixtures not started')
	return {
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-workspace',
		agentPort: agent.port,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		...overrides,
	}
}

/** The disk a workspace template is supposed to declare. */
const BLOCK_DISK = {
	metadata: { name: 'workspace' },
	spec: {
		accessModes: ['ReadWriteOnce'],
		volumeMode: 'Block',
		resources: { requests: { storage: '20Gi' } },
	},
}

function workspaceTemplate(
	overrides: {
		volumeClaimTemplates?: unknown
		volumeDevices?: unknown
		volumeMounts?: unknown
	} = {},
) {
	const container: Record<string, unknown> = { name: 'main', image: 'namzu/agent:test' }
	if ('volumeDevices' in overrides) {
		if (overrides.volumeDevices !== undefined) container.volumeDevices = overrides.volumeDevices
	} else {
		container.volumeDevices = [{ name: 'workspace', devicePath: '/dev/workspace' }]
	}
	if (overrides.volumeMounts !== undefined) container.volumeMounts = overrides.volumeMounts
	return {
		metadata: { name: 'namzu-workspace', namespace: NAMESPACE },
		spec: {
			service: true,
			volumeClaimTemplates:
				'volumeClaimTemplates' in overrides ? overrides.volumeClaimTemplates : [BLOCK_DISK],
			podTemplate: { spec: { containers: [container] } },
		},
	}
}

interface ClusterState {
	/** Flipped by the suspend PATCH; drives what the Sandbox GET reports. */
	suspended: boolean
	deleted: boolean
	/** A Sandbox of this name already stands there: the POST comes back 409. */
	exists?: boolean
	/** What the standing object's spec says, for the adopt path's own check. */
	existingSpec?: Record<string, unknown>
	/** The NetworkPolicy an operator applied. Absent = nobody applied one. */
	networkPolicySpec?: Record<string, unknown>
	/**
	 * Statuses to answer the next DELETEs with, one per request, before the
	 * normal success path resumes. A 500 is an API server that refused the
	 * request; a 404 is an object somebody else already removed.
	 */
	deleteReplies?: number[]
}

/**
 * A cluster that answers the whole workspace lifecycle: template, create,
 * readiness, pod uid, the two operatingMode patches and the delete.
 */
function startWorkspaceCluster(
	template: unknown,
	state: ClusterState = { suspended: false, deleted: false },
): Promise<FakeApiServer> {
	return startFakeApiServer((req: RecordedRequest): FakeApiReply => {
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return { status: 200, body: template }
		}
		if (req.method === 'GET' && req.path.includes('/networkpolicies/')) {
			if (state.networkPolicySpec === undefined) {
				return { status: 404, body: { message: 'not found' } }
			}
			return { status: 200, body: { spec: state.networkPolicySpec } }
		}
		if (req.method === 'POST' && req.path.endsWith('/sandboxes')) {
			if (state.exists) {
				return { status: 409, body: { message: `sandboxes "${WORKSPACE_NAME}" already exists` } }
			}
			return { status: 201, body: {} }
		}
		if (req.method === 'PATCH' && req.path.includes('/sandboxes/')) {
			const body = req.body as { spec?: { operatingMode?: string } }
			state.suspended = body.spec?.operatingMode === 'Suspended'
			return { status: 200, body: {} }
		}
		if (req.method === 'DELETE' && req.path.includes('/sandboxes/')) {
			const forced = state.deleteReplies?.shift()
			if (forced !== undefined && forced >= 300) {
				return {
					status: forced,
					body: { message: forced === 404 ? 'not found' : 'etcdserver: request timed out' },
				}
			}
			state.deleted = true
			return { status: 200, body: { kind: 'Status' } }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxes/')) {
			if (state.deleted) return { status: 404, body: { message: 'gone' } }
			return {
				status: 200,
				body: {
					metadata: { name: WORKSPACE_NAME },
					spec: {
						operatingMode: state.suspended ? 'Suspended' : 'Running',
						...(state.existingSpec ?? {}),
					},
					status: {
						// The Suspended condition is reported the way a real
						// controller reports it — `PodTerminated` is upstream's
						// Suspended=True reason, not the Ready=False
						// `SandboxSuspended` — and nothing in the backend reads it:
						// upstream leaves it True after a resume, so the suspend
						// wait polls the pod. See workspace-suspend-resume.test.ts.
						conditions: state.suspended
							? [
									readyCondition('False'),
									{
										type: 'Suspended',
										status: 'True',
										reason: 'PodTerminated',
										message: 'pod terminated',
										lastTransitionTime: '2026-09-16T00:00:00Z',
									},
								]
							: [readyCondition()],
						podIPs: ['10.244.0.11'],
						serviceFQDN: `${WORKSPACE_NAME}.${NAMESPACE}.svc.cluster.local`,
						selector: 'agents.x-k8s.io/sandbox-name-hash=ws1',
					},
				},
			}
		}
		if (req.method === 'GET' && req.path.includes('/pods/')) {
			if (state.suspended || state.deleted) return { status: 404, body: { message: 'gone' } }
			return { status: 200, body: { metadata: { name: WORKSPACE_NAME, uid: POD_UID } } }
		}
		return { status: 404, body: { message: 'unexpected' } }
	})
}

describe('creating a workspace', () => {
	it('POSTs a direct Sandbox carrying the template disk and no expiry', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		// Never a claim: a claim-level PVC forces a cold start, and
		// `volumeClaimTemplates` is immutable on the Sandbox, so the disk has
		// to be in the spec at creation.
		expect(server.matching('POST', '/sandboxclaims')).toHaveLength(0)
		const post = server.matching('POST', '/sandboxes')[0]?.body as {
			metadata: { name: string }
			spec: {
				operatingMode: string
				service: boolean
				shutdownTime?: string
				shutdownPolicy?: string
				volumeClaimTemplates: { metadata: { name: string }; spec: { volumeMode: string } }[]
				podTemplate: {
					spec: { containers: { volumeDevices?: { name: string; devicePath: string }[] }[] }
				}
			}
		}

		// Deterministic, so tomorrow's process finds the same workspace.
		expect(post.metadata.name).toBe(WORKSPACE_NAME)
		expect(workspace.id).toBe(WORKSPACE_NAME)
		expect(post.spec.operatingMode).toBe('Running')
		expect(post.spec.service).toBe(true)
		// The disk, verbatim, block-mode, and claimed as a device by the
		// container. The controller wires the mount by the entry's own name.
		expect(post.spec.volumeClaimTemplates).toEqual([BLOCK_DISK])
		expect(post.spec.volumeClaimTemplates[0]?.spec.volumeMode).toBe('Block')
		expect(post.spec.podTemplate.spec.containers[0]?.volumeDevices).toEqual([
			{ name: 'workspace', devicePath: '/dev/workspace' },
		])
		// No lease. An expiry on a workspace is a timer that deletes the
		// caller's files, and a renewal loop makes keeping them conditional on
		// a host process staying up.
		expect(post.spec.shutdownTime).toBeUndefined()
		expect(post.spec.shutdownPolicy).toBeUndefined()
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).toBe('ready')
		expect(workspace.rootDir).toBe('/workspace')
	})

	it('refuses a Filesystem disk by name, before anything is created', async () => {
		server = await startWorkspaceCluster(
			workspaceTemplate({
				volumeClaimTemplates: [
					{ metadata: { name: 'workspace' }, spec: { volumeMode: 'Filesystem' } },
				],
			}),
		)
		const failure = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceDiskError)
		// The message has to name the trap, because the shape it refuses works.
		expect((failure as Error).message).toMatch(/volumeMode: Block/)
		expect((failure as Error).message).toMatch(/virtio-fs/)
		expect(server.matching('POST', '/sandboxes')).toHaveLength(0)
	})

	it('refuses a template that declares no disk at all', async () => {
		server = await startWorkspaceCluster(workspaceTemplate({ volumeClaimTemplates: undefined }))
		await expect(
			createKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(/declares no spec\.volumeClaimTemplates/)
		expect(server.matching('POST', '/sandboxes')).toHaveLength(0)
	})

	it('refuses a Block disk no container claims through volumeDevices', async () => {
		server = await startWorkspaceCluster(workspaceTemplate({ volumeDevices: undefined }))
		await expect(
			createKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(/no container claims it through volumeDevices/)
	})

	it('refuses a Block disk consumed as a filesystem volumeMount', async () => {
		server = await startWorkspaceCluster(
			workspaceTemplate({
				volumeDevices: undefined,
				volumeMounts: [{ name: 'workspace', mountPath: '/workspace' }],
			}),
		)
		await expect(
			createKubernetesWorkspace(config(), {
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
			}),
		).rejects.toThrow(/through a container's volumeMounts/)
	})

	it('refuses a workspace id that cannot name a Sandbox rather than sanitising it', () => {
		// Two ids that sanitise to one name would silently share one disk.
		expect(() => workspaceSandboxName('Acme Checkout')).toThrow(/cannot name a Sandbox/)
		expect(() => workspaceSandboxName('-leading')).toThrow(/cannot name a Sandbox/)
		expect(() => workspaceSandboxName('x'.repeat(55))).toThrow(/cannot name a Sandbox/)
		expect(workspaceSandboxName('acme-checkout-7')).toBe(WORKSPACE_NAME)
	})
})

/**
 * The standing object an adopt finds: by default the exact shape this backend
 * would have POSTed, including the template label `buildSandboxBody` stamps.
 * `templateLabel: null` is an object that carries none — an operator's, or an
 * older backend's — and `runtimeClassName` is what the pod really runs under,
 * whatever the caller configured.
 */
function existingWorkspaceSpec(
	overrides: { templateLabel?: string | null; runtimeClassName?: string } = {},
): Record<string, unknown> {
	const label = overrides.templateLabel === undefined ? 'namzu-workspace' : overrides.templateLabel
	const podSpec: Record<string, unknown> = {
		containers: [
			{
				name: 'main',
				image: 'namzu/agent:test',
				volumeDevices: [{ name: 'workspace', devicePath: '/dev/workspace' }],
			},
		],
	}
	if (overrides.runtimeClassName !== undefined)
		podSpec.runtimeClassName = overrides.runtimeClassName
	return {
		volumeClaimTemplates: [BLOCK_DISK],
		podTemplate: {
			...(label === null ? {} : { metadata: { labels: { 'sandbox.namzu.ai/template': label } } }),
			spec: podSpec,
		},
	}
}

describe('reattaching to a workspace that already exists', () => {
	const existingSpec = existingWorkspaceSpec()

	it('adopts the suspended object and wakes it instead of failing on the 409', async () => {
		// The deterministic name only buys anything if coming back to it is the
		// normal path: a second host process, or the same one tomorrow, POSTs
		// the same name and must get its workspace rather than a conflict.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: true,
			deleted: false,
			exists: true,
			existingSpec,
		})
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual({ spec: { operatingMode: 'Running' } })
		expect(workspace.id).toBe(WORKSPACE_NAME)
		expect(workspace.suspended).toBe(false)
		// Nothing was deleted and re-created: the disk is the whole point.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})

	it('sends no patch when the standing object is already running', async () => {
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: false,
			deleted: false,
			exists: true,
			existingSpec,
		})
		await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
	})

	it('refuses to adopt an object of that name that is not a block-disk workspace', async () => {
		// Something else is standing under this name. Using it would hand the
		// caller a "workspace" whose files vanish on the first suspend.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: false,
			deleted: false,
			exists: true,
			existingSpec: { volumeClaimTemplates: undefined, podTemplate: { spec: { containers: [] } } },
		})
		const failure = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceDiskError)
		expect((failure as KubernetesWorkspaceDiskError).source).toContain(`Sandbox ${WORKSPACE_NAME}`)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
	})

	it('refuses an object built from another template than the policy it just verified', async () => {
		// The silent downgrade this check exists for. The NetworkPolicy is
		// verified for the template the CALLER named; the 409 then hands back
		// an object built from a different one, whose pod carries a different
		// `sandbox.namzu.ai/template` label — and that label is exactly what
		// the policy's podSelector matches. Without the check the call returns
		// a working workspace having reported a boundary that does not select
		// its pod.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: true,
			deleted: false,
			exists: true,
			existingSpec: existingWorkspaceSpec({ templateLabel: 'some-other-template' }),
			networkPolicySpec: denyAllNetworkPolicySpec('namzu-workspace'),
		})
		const failure = await createKubernetesWorkspace(
			config({ egress: { policy: { kind: 'deny-all' } } }),
			{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
		).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		const mismatch = failure as KubernetesWorkspaceMismatchError
		expect(mismatch.field).toBe('sandboxTemplateName')
		expect(mismatch.expected).toBe('namzu-workspace')
		expect(mismatch.actual).toBe('some-other-template')
		expect(mismatch.message).toMatch(/podSelector/)
		// The policy WAS verified — and the object was still refused. Nothing
		// was woken on the way out, and the guest was never reached.
		expect(server.matching('GET', '/networkpolicies/')).toHaveLength(1)
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		expect(agent?.connections.length).toBe(0)
	})

	it('refuses an object carrying no template label at all', async () => {
		// An object created by hand, or by something that is not this backend:
		// no label means no policy selects it either.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: false,
			deleted: false,
			exists: true,
			existingSpec: existingWorkspaceSpec({ templateLabel: null }),
		})
		const failure = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		expect((failure as KubernetesWorkspaceMismatchError).actual).toBeUndefined()
		expect((failure as Error).message).toMatch(/\(absent\)/)
		// Refused with no egress config in sight: the label is how an operator
		// reads which template an object came from, so the mix-up is named the
		// first time it is seen rather than the first time a policy is added.
		expect(agent?.connections.length).toBe(0)
	})

	it('refuses an object running without the configured RuntimeClass', async () => {
		// The VM boundary, which is the last control to lose quietly — and the
		// privilege probe cannot stand in for it: /proc/self/status reads the
		// same under Kata and under runc.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: true,
			deleted: false,
			exists: true,
			existingSpec: existingWorkspaceSpec(),
		})
		const failure = await createKubernetesWorkspace(config({ runtimeClassName: 'kata-qemu' }), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		}).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesWorkspaceMismatchError)
		const mismatch = failure as KubernetesWorkspaceMismatchError
		expect(mismatch.field).toBe('runtimeClassName')
		expect(mismatch.expected).toBe('kata-qemu')
		expect(mismatch.actual).toBeUndefined()
		expect(mismatch.message).toMatch(/privilege probe/)
		// Not resumed, and not probed: an object this call will not use is not
		// woken up on the way to being rejected.
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(agent?.connections.length).toBe(0)
	})

	it('adopts an object whose RuntimeClass is the configured one', async () => {
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: true,
			deleted: false,
			exists: true,
			existingSpec: existingWorkspaceSpec({ runtimeClassName: 'kata-qemu' }),
		})
		const workspace = await createKubernetesWorkspace(config({ runtimeClassName: 'kata-qemu' }), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual({ spec: { operatingMode: 'Running' } })
		expect(workspace.suspended).toBe(false)
	})
})

describe('destroy', () => {
	it('defaults to suspending and keeps the disk', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await workspace.destroy()

		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
		const patches = server.requests.filter((r) => r.method === 'PATCH')
		expect(patches).toHaveLength(1)
		expect(patches[0]?.body).toEqual({ spec: { operatingMode: 'Suspended' } })
		expect(workspace.suspended).toBe(true)
	})

	it('deletes the Sandbox, and with it the disk, only when asked', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await workspace.destroy({ deleteDisk: true })

		// One DELETE, and no suspend on the way: there is no
		// delete-compute-keep-disk verb, so a delete is just a delete.
		const deletes = server.requests.filter((r) => r.method === 'DELETE')
		expect(deletes).toHaveLength(1)
		expect(deletes[0]?.path).toContain(`/sandboxes/${WORKSPACE_NAME}`)
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(workspace.suspended).toBe(false)
		expect(workspace.status).toBe('destroyed')
		// A deleted workspace is not a suspended one, and says so.
		await expect(workspace.exec('true')).rejects.toThrow(/has been destroyed/)
	})

	it('is idempotent', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await workspace.destroy({ deleteDisk: true })
		await workspace.destroy({ deleteDisk: true })
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('stays retryable when the DELETE fails, instead of recording one that did not happen', async () => {
		// The defect this guards: `deleted` marked before the request lands is
		// what every later destroy() early-returns on, so a 500 is thrown once
		// and the Sandbox — with its pod, its Service and its PVC — then
		// stands on the cluster with nothing left that would remove it.
		const cluster: ClusterState = { suspended: false, deleted: false, deleteReplies: [500] }
		server = await startWorkspaceCluster(workspaceTemplate(), cluster)
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		const failure = await workspace.destroy({ deleteDisk: true }).catch((err: unknown) => err)
		expect((failure as Error).message).toMatch(/500/)
		expect(cluster.deleted).toBe(false)
		// Not recorded — and not quietly turned into a suspend either: the
		// cluster was asked for a delete and for nothing else.
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		// What it does report is the session it tore down on the way there.
		// The handle that served this workspace is gone, so no call can be
		// admitted, and the state says WHICH kind of "cannot serve" that is: a
		// workspace still calling itself running with no session behind it
		// would refuse every call and every resume alike, which is a wedge
		// rather than a failure.
		expect(workspace.suspended).toBe(true)
		await expect(workspace.exec('true')).rejects.toBeInstanceOf(KubernetesWorkspaceSuspendedError)

		// So both ways out stay open. The workspace can be brought back —
		// nothing was deleted, and nothing was suspended either...
		await workspace.resume()
		expect(workspace.suspended).toBe(false)
		expect((await workspace.exec('true')).exitCode).toBe(0)

		// ...and the delete can be retried, which is the only thing that
		// makes the failure survivable.
		await workspace.destroy({ deleteDisk: true })
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(2)
		expect(cluster.deleted).toBe(true)
		expect(workspace.status).toBe('destroyed')
		await expect(workspace.exec('true')).rejects.toThrow(/has been destroyed/)
	})

	it('counts an object that is already gone as deleted', async () => {
		// 404 is the state the DELETE was asking for, so it is a success and
		// not a failure to retry forever.
		const cluster: ClusterState = { suspended: false, deleted: false, deleteReplies: [404] }
		server = await startWorkspaceCluster(workspaceTemplate(), cluster)
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		await workspace.destroy({ deleteDisk: true })
		expect(workspace.status).toBe('destroyed')
		await expect(workspace.exec('true')).rejects.toThrow(/has been destroyed/)
		// And it IS recorded, so a second call sends nothing.
		await workspace.destroy({ deleteDisk: true })
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('shares one DELETE between concurrent destroy calls', async () => {
		// Deferring the mark until the DELETE lands opens a window the
		// serialisation queue does not close by itself: a second destroy()
		// admitted after the first one fails finds nothing marked and sends a
		// second DELETE. A single flight is what closes it.
		const cluster: ClusterState = { suspended: false, deleted: false, deleteReplies: [500] }
		server = await startWorkspaceCluster(workspaceTemplate(), cluster)
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		const first = workspace.destroy({ deleteDisk: true }).catch((err: unknown) => err)
		const second = workspace.destroy({ deleteDisk: true }).catch((err: unknown) => err)
		const [a, b] = await Promise.all([first, second])

		expect(a).toBeInstanceOf(Error)
		// The same rejection object: one DELETE, awaited twice.
		expect(b).toBe(a)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
		// The one refusal the fixture had was consumed once, not twice.
		expect(cluster.deleteReplies).toHaveLength(0)

		await workspace.destroy({ deleteDisk: true })
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(2)
		expect(cluster.deleted).toBe(true)
	})

	it('stays a no-op once the disk is gone, whichever destroy asked for it', async () => {
		// The shape this guards is a body that deletes explicitly inside a
		// `finally` that calls `destroy()`. A default destroy is a suspend,
		// and suspending a workspace that no longer exists is an error — but
		// `destroy()` is idempotent, and handing that caller an error naming
		// an operation they never typed, out of their cleanup, is exactly
		// what idempotence is for.
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await workspace.destroy({ deleteDisk: true })

		await expect(workspace.destroy()).resolves.toBeUndefined()
		await expect(workspace.destroy({ deleteDisk: false })).resolves.toBeUndefined()
		// And it is a no-op in the literal sense: nothing was asked of the
		// cluster, least of all a suspend patch against a deleted object.
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
		// An explicit suspend() is still a mistake, and still says so.
		await expect(workspace.suspend()).rejects.toThrow(/has been destroyed/)
	})

	it('is a no-op for a plain destroy the delete overtakes', async () => {
		// Both admitted while the workspace is still standing, so neither can
		// early-return on a state: the delete takes the queue first and the
		// suspend behind it finds a workspace that has gone. It asked for the
		// workspace gone; the workspace is gone.
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		const deleting = workspace.destroy({ deleteDisk: true })
		const closing = workspace.destroy()
		await expect(deleting).resolves.toBeUndefined()
		await expect(closing).resolves.toBeUndefined()

		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
		expect(server.requests.filter((r) => r.method === 'PATCH')).toHaveLength(0)
		expect(workspace.status).toBe('destroyed')
	})
})

describe('the optional methods a workspace does not offer', () => {
	it('omits setNetworkPolicy and spawnDetached, exactly as a task sandbox does', async () => {
		// Asserted on the WRAPPER, not only on the handle it wraps: the
		// workspace builds its own object literal, so an optional method could
		// appear here — or the two real ones disappear — without the task
		// sandbox's own assertion noticing. Egress is a NetworkPolicy on a
		// template rather than a per-pod knob, and the guest agent has no op
		// that starts a process and leaves it running, so the SDK's contract
		// says omit rather than accept and ignore.
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})

		expect(workspace.setNetworkPolicy).toBeUndefined()
		expect(workspace.spawnDetached).toBeUndefined()
		expect(workspace.walkFiles).toBeUndefined()
		// The ones it does offer are present, and typed present.
		expect(typeof workspace.openTerminal).toBe('function')
		expect(typeof workspace.openTcpConnection).toBe('function')
		await workspace.destroy()
	})
})

describe('calls against a suspended workspace', () => {
	it('refuse by name and never dial', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const workspace = await createKubernetesWorkspace(config(), {
			workspaceId: WORKSPACE_ID,
			workingDirectory: '/workspace',
		})
		await workspace.suspend()
		if (!agent) throw new Error('fixtures not started')
		const dialsBefore = agent.connections.length

		const failure = await workspace.exec('true').catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(KubernetesWorkspaceSuspendedError)
		expect((failure as Error).message).toMatch(/call resume\(\)/)
		await expect(workspace.readFile('/workspace/x')).rejects.toBeInstanceOf(
			KubernetesWorkspaceSuspendedError,
		)
		await expect(workspace.writeFile('/workspace/x', 'y')).rejects.toBeInstanceOf(
			KubernetesWorkspaceSuspendedError,
		)
		await expect(workspace.listFiles('/workspace')).rejects.toBeInstanceOf(
			KubernetesWorkspaceSuspendedError,
		)
		// The point of the named refusal: the Service outlives the pod, so a
		// dial would resolve and then hang on a connect timeout that names
		// nothing.
		expect(agent.connections.length).toBe(dialsBefore)
		expect(workspace.status).toBe('destroyed')
		expect(workspace.suspended).toBe(true)
	})
})

/** The `deny-all` translation, for whichever template name is the target. */
function denyAllNetworkPolicySpec(sandboxTemplateName: string): Record<string, unknown> {
	return {
		podSelector: { matchLabels: { 'sandbox.namzu.ai/template': sandboxTemplateName } },
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
}

describe('the egress policy a workspace is covered by', () => {
	// A workspace never goes through `buildKubernetesBackend`, so every one of
	// these would pass by simply not looking. The failure they guard is the
	// silent one: the same `config.egress` object refused on the provider
	// entry point and ignored on this one, on the sandbox most likely to be
	// pointed at a network and longest-lived when it is.

	it('refuses a hostname allowlist the default engine cannot enforce, before contacting anything', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const failure = await createKubernetesWorkspace(
			config({ egress: { policy: { kind: 'static', allowedHosts: ['registry.example'] } } }),
			{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
		).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesUnenforceableEgressPolicyError)
		// Decided from the policy kind alone, so not one request was made —
		// the same synchronous refusal `buildKubernetesBackend` makes.
		expect(server.requests).toHaveLength(0)
	})

	it('refuses a policy nobody applied, before anything is created', async () => {
		server = await startWorkspaceCluster(workspaceTemplate())
		const failure = await createKubernetesWorkspace(
			config({ egress: { policy: { kind: 'deny-all' } } }),
			{ workspaceId: WORKSPACE_ID, workingDirectory: '/workspace' },
		).catch((err: unknown) => err)

		expect(failure).toBeInstanceOf(KubernetesEgressPolicyNotAppliedError)
		expect(server.matching('GET', '/networkpolicies/')).toHaveLength(1)
		// Verify-not-trust means exactly that: nothing is created, and the
		// policy is never created either.
		expect(server.matching('POST', '/sandboxes')).toHaveLength(0)
		expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(0)
	})

	it('verifies the policy of the template the workspace is actually built from', async () => {
		// The backend's default template is the task one; this workspace is
		// built from another. The policy that covers it is the one selecting
		// THAT template's label — the pod this POST creates carries no other.
		server = await startWorkspaceCluster(workspaceTemplate(), {
			suspended: false,
			deleted: false,
			networkPolicySpec: denyAllNetworkPolicySpec('namzu-workspace'),
		})
		await createKubernetesWorkspace(
			config({ sandboxTemplateName: 'namzu-task', egress: { policy: { kind: 'deny-all' } } }),
			{
				workspaceId: WORKSPACE_ID,
				workingDirectory: '/workspace',
				sandboxTemplateName: 'namzu-workspace',
			},
		)

		const verified = server.matching('GET', '/networkpolicies/')
		expect(verified).toHaveLength(1)
		expect(verified[0]?.path).toContain('namzu-workspace-egress')
		const post = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: { podTemplate: { metadata?: { labels?: Record<string, string> } } }
		}
		// The label the verified policy selects by, on the pod that was created.
		expect(post.spec.podTemplate.metadata?.labels?.['sandbox.namzu.ai/template']).toBe(
			'namzu-workspace',
		)
	})
})

describe('the pool-less task path', () => {
	it('carries the template volumeClaimTemplates it used to drop', async () => {
		// Regression: the pool-less create copied `spec.podTemplate` and left
		// `spec.volumeClaimTemplates` behind, so a task template that declared
		// a disk produced a Sandbox with none — healthy, and missing the
		// volume its container names.
		server = await startWorkspaceCluster(workspaceTemplate())
		const sandbox = await buildKubernetesBackend(
			config({ sandboxTemplateName: 'namzu-workspace' }),
		).create({ workingDirectory: '/workspace' })

		const post = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: { volumeClaimTemplates?: unknown; shutdownTime?: string }
		}
		expect(post.spec.volumeClaimTemplates).toEqual([BLOCK_DISK])
		// A task sandbox still carries its expiry; only a workspace does not.
		expect(typeof post.spec.shutdownTime).toBe('string')
		await sandbox.destroy()
	})

	it('omits the key entirely for a template that declares no disk', async () => {
		server = await startWorkspaceCluster(workspaceTemplate({ volumeClaimTemplates: undefined }))
		const sandbox = await buildKubernetesBackend(config()).create({
			workingDirectory: '/workspace',
		})
		const post = server.matching('POST', '/sandboxes')[0]?.body as {
			spec: Record<string, unknown>
		}
		expect(post.spec).not.toHaveProperty('volumeClaimTemplates')
		await sandbox.destroy()
	})
})
