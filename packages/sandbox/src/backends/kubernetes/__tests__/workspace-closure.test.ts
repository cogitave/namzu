import { afterEach, describe, expect, it } from 'vitest'

import {
	KubernetesWorkspaceClosureConflictError,
	type KubernetesWorkspaceDeleteOptions,
	deleteKubernetesWorkspace,
	reconcileKubernetesWorkspaceClosure,
} from '../../../index.js'
import { type FakeApiServer, startFakeApiServer } from './fixtures/fake-api-server.js'

const workspaceId = 'retained-closure'
const name = `namzu-ws-${workspaceId}`
const namespace = 'namzu-sandboxes'
const identity = {
	sandboxUid: 'sandbox-original',
	podUid: 'pod-original',
	guestBootId: 'boot-original',
	volumeClaimUids: { workspace: 'claim-original' },
}
const ownerReferences = [{ uid: identity.sandboxUid, controller: true }]
const sandbox = {
	metadata: {
		uid: identity.sandboxUid,
		resourceVersion: '8',
		annotations: { 'sandbox.namzu.ai/holder-epoch': '7' },
	},
	spec: {
		operatingMode: 'Suspended',
		volumeClaimTemplates: [{ metadata: { name: 'workspace' } }],
	},
}
const claim = {
	metadata: { uid: 'claim-original', resourceVersion: '9', ownerReferences },
}
const pod = {
	metadata: {
		name: 'non-conventional-pod-name',
		uid: identity.podUid,
		ownerReferences,
	},
	status: { phase: 'Running' },
}

let server: FakeApiServer | undefined
afterEach(async () => {
	await server?.close()
	server = undefined
})

async function fixture(
	options: {
		sandbox?: unknown | null
		claim?: unknown | null
		pods?: unknown[]
		onSandboxRead?: (read: number) => unknown | null
		onPodsRead?: (read: number, path: string) => unknown
		onDelete?: () => { status: number; body?: unknown }
	} = {},
) {
	let sandboxReads = 0
	let podReads = 0
	server = await startFakeApiServer((request) => {
		if (request.method === 'DELETE' && options.onDelete) return options.onDelete()
		expect(request.method).toBe('GET')
		if (request.path.includes('/sandboxes/')) {
			const value = options.onSandboxRead
				? options.onSandboxRead(++sandboxReads)
				: 'sandbox' in options
					? options.sandbox
					: sandbox
			return value === null ? { status: 404 } : { status: 200, body: value }
		}
		if (request.path.includes('/persistentvolumeclaims/')) {
			const value = 'claim' in options ? options.claim : claim
			return value === null ? { status: 404 } : { status: 200, body: value }
		}
		if (request.path.includes('/pods?'))
			return {
				status: 200,
				body: options.onPodsRead
					? options.onPodsRead(++podReads, request.path)
					: { items: options.pods ?? [] },
			}
		return { status: 500 }
	})
	const config = {
		tier: 'microvm' as const,
		service: 'kubernetes' as const,
		namespace,
		sandboxTemplateName: 'unused',
		access: { server: server.url, getToken: async () => 'test-token' },
	}
	return {
		removeWith: (suspendedTarget: unknown) =>
			deleteKubernetesWorkspace(config, workspaceId, {
				suspendedTarget,
			} as KubernetesWorkspaceDeleteOptions),
		observe: () =>
			reconcileKubernetesWorkspaceClosure(config, workspaceId, {
				identity,
				epoch: 7,
			}),
		remove: () =>
			deleteKubernetesWorkspace(config, workspaceId, {
				suspendedTarget: { identity, epoch: 7 },
			}),
		requests: server.requests,
	}
}

describe('retained workspace closure observation', () => {
	it.each([
		null,
		false,
		'',
		undefined,
		{},
		{ identity },
		{ identity: null, epoch: 7 },
		{ identity: { ...identity, volumeClaimUids: null }, epoch: 7 },
		{ identity: { ...identity, volumeClaimUids: {} }, epoch: 7 },
		{ identity: { ...identity, podUid: '' }, epoch: 7 },
		{ identity, epoch: -1 },
	])('refuses a malformed provided suspended target before any I/O %#', async (target) => {
		const f = await fixture({ onDelete: () => ({ status: 200, body: {} }) })
		await expect(f.removeWith(target)).rejects.toThrow()
		expect(f.requests).toEqual([])
	})

	it('deletes only a verified suspended owner using its UID and observed resourceVersion', async () => {
		const f = await fixture({ onDelete: () => ({ status: 200, body: {} }) })
		await f.remove()
		const writes = f.requests.filter((request) => request.method !== 'GET')
		expect(writes).toHaveLength(1)
		expect(writes[0]).toMatchObject({
			method: 'DELETE',
			body: {
				apiVersion: 'v1',
				kind: 'DeleteOptions',
				preconditions: { uid: identity.sandboxUid, resourceVersion: '8' },
			},
		})
	})

	it('does not retry a delete when a concurrent resume defeats its resourceVersion', async () => {
		const f = await fixture({ onDelete: () => ({ status: 409 }) })
		await expect(f.remove()).rejects.toThrow()
		expect(f.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1)
	})

	it.each([
		{
			sandbox: {
				...sandbox,
				spec: { ...sandbox.spec, operatingMode: 'Running' },
			},
		},
		{ pods: [pod] },
		{ claim: { metadata: { ...claim.metadata, uid: 'replacement' } } },
		{
			sandbox: {
				...sandbox,
				metadata: { ...sandbox.metadata, uid: 'replacement' },
			},
		},
		{
			sandbox: {
				...sandbox,
				metadata: {
					...sandbox.metadata,
					annotations: { 'sandbox.namzu.ai/holder-epoch': '8' },
				},
			},
		},
		{ sandbox: null, claim: null, pods: [pod] },
		{ sandbox: null },
	])('does not delete a changed, active, or partly removed owner %#', async (options) => {
		const f = await fixture({
			...options,
			onDelete: () => ({ status: 200 }),
		})
		await expect(f.remove()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
		expect(f.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('reconciles a lost delete reply only after all retained dependents are gone', async () => {
		let removed = false
		const f = await fixture({
			onSandboxRead: () => (removed ? null : sandbox),
			onPodsRead: () => ({ items: [] }),
			onDelete: () => {
				removed = true
				return { status: 503 }
			},
		})
		await expect(f.remove()).rejects.toThrow()
		// A remaining claim prevents false completion even when the owner is gone.
		await expect(f.remove()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
		expect(f.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1)
	})

	it('accepts already-complete deletion with no write', async () => {
		const f = await fixture({ sandbox: null, claim: null })
		await f.remove()
		expect(f.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it('observes suspension without creating, acquiring or contacting an agent', async () => {
		const f = await fixture()
		expect(await f.observe()).toBe('suspended')
		expect(f.requests.filter((request) => request.path.includes('/sandboxes/'))).toHaveLength(3)
		expect(
			f.requests.filter((request) => request.path.includes('/persistentvolumeclaims/')),
		).toHaveLength(2)
		expect(f.requests.every((request) => request.method === 'GET')).toBe(true)
	})

	it.each(['Running', 'Pending'])('does not report a %s pod as suspended', async (phase) => {
		const f = await fixture({
			pods: [
				{
					...pod,
					metadata: {
						...pod.metadata,
						deletionTimestamp: '2026-10-12T00:00:00Z',
					},
					status: { phase },
				},
			],
		})
		expect(await f.observe()).toBe('stopping')
	})

	it.each(['Succeeded', 'Failed'])(
		'observes suspension after the original pod is %s',
		async (phase) => {
			const f = await fixture({ pods: [{ ...pod, status: { phase } }] })
			expect(await f.observe()).toBe('suspended')
		},
	)

	it('observes deletion only after the owner and all original dependents are gone', async () => {
		const f = await fixture({ sandbox: null, claim: null })
		expect(await f.observe()).toBe('deleted')
	})

	it('retains deletion while the original PVC remains', async () => {
		const f = await fixture({ sandbox: null })
		expect(await f.observe()).toBe('stopping')
	})

	it('retains deletion while the original pod remains under an unexpected name', async () => {
		const f = await fixture({ sandbox: null, claim: null, pods: [pod] })
		expect(await f.observe()).toBe('stopping')
	})

	it('does not confuse an accepted Sandbox deletion with physical completion', async () => {
		const f = await fixture({
			sandbox: {
				...sandbox,
				metadata: {
					...sandbox.metadata,
					deletionTimestamp: '2026-10-12T00:00:00Z',
				},
			},
		})
		expect(await f.observe()).toBe('stopping')
	})

	it('keeps an unchanged running owner unfinished', async () => {
		const f = await fixture({
			sandbox: {
				...sandbox,
				spec: { ...sandbox.spec, operatingMode: 'Running' },
			},
			pods: [pod],
		})
		expect(await f.observe()).toBe('live')
	})

	it.each([
		{
			sandbox: {
				...sandbox,
				metadata: { ...sandbox.metadata, uid: 'replacement' },
			},
		},
		{
			sandbox: {
				...sandbox,
				metadata: {
					...sandbox.metadata,
					annotations: { 'sandbox.namzu.ai/holder-epoch': '8' },
				},
			},
		},
		{ claim: { metadata: { ...claim.metadata, uid: 'replacement' } } },
		{
			claim: {
				metadata: {
					...claim.metadata,
					ownerReferences: [{ uid: 'replacement', controller: true }],
				},
			},
		},
		{ claim: null },
		{
			pods: [
				{
					...pod,
					metadata: {
						...pod.metadata,
						uid: 'replacement',
						name: 'also-unexpected',
					},
				},
			],
		},
		{
			pods: [
				{
					...pod,
					metadata: {
						...pod.metadata,
						uid: 'replacement',
						ownerReferences: [],
						name,
					},
				},
			],
		},
	])('refuses replacement, epoch, ownership or incomplete disk evidence %#', async (options) => {
		const f = await fixture(options)
		await expect(f.observe()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
	})

	it('refuses a changed owner between dependent observations', async () => {
		const f = await fixture({
			onSandboxRead: (read) =>
				read === 1
					? sandbox
					: {
							...sandbox,
							metadata: { ...sandbox.metadata, resourceVersion: '10' },
						},
		})
		await expect(f.observe()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
	})

	it('rechecks pod evidence before reporting a completed suspension', async () => {
		const f = await fixture({
			onPodsRead: (read) => ({ items: read === 1 ? [] : [pod] }),
		})
		await expect(f.observe()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
	})

	it('reads every pod page, including an original pod on a later page', async () => {
		const f = await fixture({
			sandbox: null,
			claim: null,
			onPodsRead: (_read, path) =>
				path.includes('continue=second')
					? { items: [pod] }
					: { items: [], metadata: { continue: 'second' } },
		})
		expect(await f.observe()).toBe('stopping')
		expect(f.requests.some((request) => request.path.includes('continue=second'))).toBe(true)
	})

	it('refuses an inventory that exceeds the page budget', async () => {
		const f = await fixture({
			onPodsRead: (read) => ({
				items: [],
				metadata: { continue: String(read) },
			}),
		})
		await expect(f.observe()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
		expect(f.requests.filter((request) => request.path.includes('/pods?'))).toHaveLength(10)
	})

	it('does not treat an empty successful response as absence', async () => {
		const f = await fixture({ sandbox: undefined })
		await expect(f.observe()).rejects.toBeInstanceOf(KubernetesWorkspaceClosureConflictError)
	})
})
