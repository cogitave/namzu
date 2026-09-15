import { type Server, createServer } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	KubernetesAlreadyGoneError,
	KubernetesConflictError,
	KubernetesCredentialError,
	createKubernetesClient,
} from '../k8s-client.js'
import { CA_CRT, SERVER_CRT, SERVER_KEY } from './fixtures/https-pki.js'

// vi.spyOn cannot patch a live ESM namespace's export (Node's ESM bindings
// are non-configurable), so proving the explicit-access path never touches
// the ServiceAccount files needs a full module mock instead of a spy — the
// documented vitest workaround for this exact limitation.
const readFileSyncCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			readFileSyncCalls.count += 1
			return actual.readFileSync(...args)
		},
	}
})

const realFetch = globalThis.fetch

afterEach(() => {
	vi.restoreAllMocks()
	globalThis.fetch = realFetch
})

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

describe('createKubernetesClient — explicit access, default fetch path', () => {
	it('calls getToken once per request and never touches the filesystem', async () => {
		readFileSyncCalls.count = 0
		let calls = 0
		const getToken = vi.fn(async () => {
			calls += 1
			return `token-${calls}`
		})
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer token-${calls}`)
			return jsonResponse(200, { ok: true })
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns-a',
			getToken,
		})

		await client.request('GET', '/apis/agents.x-k8s.io/v1/namespaces/ns-a/sandboxes')
		await client.request('GET', '/apis/agents.x-k8s.io/v1/namespaces/ns-a/sandboxes')

		expect(getToken).toHaveBeenCalledTimes(2)
		expect(fetchSpy).toHaveBeenCalledTimes(2)
		expect(readFileSyncCalls.count).toBe(0)
		expect(client.namespace()).toBe('ns-a')
	})

	it('sends PATCH with application/merge-patch+json and the exact JSON body', async () => {
		const patchBody = { spec: { operatingMode: 'Suspended' } }
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>
			expect(init?.method).toBe('PATCH')
			expect(headers['content-type']).toBe('application/merge-patch+json')
			expect(init?.body).toBe(JSON.stringify(patchBody))
			return jsonResponse(200, { ok: true })
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		await client.request('PATCH', '/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1', patchBody)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('sends POST with plain application/json', async () => {
		const createBody = { metadata: { name: 's1' } }
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>
			expect(init?.method).toBe('POST')
			expect(headers['content-type']).toBe('application/json')
			expect(init?.body).toBe(JSON.stringify(createBody))
			return jsonResponse(201, createBody)
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		const result = await client.request(
			'POST',
			'/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxclaims',
			createBody,
		)
		expect(result).toEqual(createBody)
	})

	it.each([404, 410])('maps %d to KubernetesAlreadyGoneError', async (status) => {
		globalThis.fetch = vi.fn(
			async () => new Response('gone', { status }),
		) as unknown as typeof fetch
		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		await expect(client.request('DELETE', '/apis/x/v1/namespaces/ns/sandboxes/s1')).rejects.toThrow(
			KubernetesAlreadyGoneError,
		)
	})

	it('maps 409 to KubernetesConflictError', async () => {
		globalThis.fetch = vi.fn(
			async () => new Response('conflict', { status: 409 }),
		) as unknown as typeof fetch
		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		await expect(client.request('POST', '/apis/x/v1/namespaces/ns/sandboxclaims')).rejects.toThrow(
			KubernetesConflictError,
		)
	})

	it('maps 403 to a credential error naming verb+resource with no token substring', async () => {
		globalThis.fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ message: 'forbidden: secret-token-xyz' }), {
					status: 403,
					headers: { 'content-type': 'application/json' },
				}),
		) as unknown as typeof fetch
		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 'super-secret-bearer-value',
		})
		const resource = '/apis/x/v1/namespaces/ns/sandboxclaims/s1'
		const failure = await client.request('GET', resource).then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(failure).toBeInstanceOf(KubernetesCredentialError)
		expect(failure).toMatchObject({
			verb: 'GET',
			resource,
			status: 403,
		})
		const message = failure instanceof Error ? failure.message : String(failure)
		expect(message).not.toContain('super-secret-bearer-value')
		expect(message).not.toContain('secret-token-xyz')
		expect(message).toContain('GET')
		expect(message).toContain(resource)
	})

	it('aborts immediately with no network call when the signal is already aborted', async () => {
		const fetchSpy = vi.fn(async () => jsonResponse(200, {}))
		globalThis.fetch = fetchSpy as unknown as typeof fetch
		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		const controller = new AbortController()
		controller.abort()
		await expect(
			client.request('GET', '/apis/x/v1/namespaces/ns/sandboxes', undefined, controller.signal),
		).rejects.toBeTruthy()
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('rejects promptly on mid-flight abort against a real server, with no pending request', async () => {
		let sawClose = false
		const server: Server = createServer((_req, res) => {
			// Deliberately never responds; the client must give up on its own.
			_req.on('close', () => {
				sawClose = true
			})
			void res
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const address = server.address() as AddressInfo
		try {
			const client = createKubernetesClient({
				server: `http://127.0.0.1:${address.port}`,
				namespace: 'ns',
				getToken: async () => 't',
			})
			const controller = new AbortController()
			const pending = client.request(
				'GET',
				'/apis/x/v1/namespaces/ns/sandboxes',
				undefined,
				controller.signal,
			)
			setTimeout(() => controller.abort(), 10)
			const started = Date.now()
			await expect(pending).rejects.toBeTruthy()
			expect(Date.now() - started).toBeLessThan(2_000)
			await vi.waitFor(() => expect(sawClose).toBe(true), { timeout: 2_000 })
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	})
})

describe('createKubernetesClient — custom CA goes through node:https', () => {
	let server: HttpsServer | undefined

	afterEach(async () => {
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()))
			server = undefined
		}
	})

	it('completes a real TLS round trip when ca is supplied, carrying the bearer token', async () => {
		let seenAuth: string | undefined
		server = createHttpsServer({ cert: SERVER_CRT, key: SERVER_KEY }, (req, res) => {
			seenAuth = req.headers.authorization
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ ok: true }))
		})
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
		const address = server.address() as AddressInfo

		const client = createKubernetesClient({
			server: `https://127.0.0.1:${address.port}`,
			namespace: 'ns',
			ca: CA_CRT,
			getToken: async () => 'k8s-bearer-token',
		})
		const result = await client.request<{ ok: boolean }>(
			'GET',
			'/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes',
		)
		expect(result).toEqual({ ok: true })
		expect(seenAuth).toBe('Bearer k8s-bearer-token')
	})

	it('refuses the same server over plain fetch (no ca) — the self-signed cert is untrusted', async () => {
		server = createHttpsServer({ cert: SERVER_CRT, key: SERVER_KEY }, (_req, res) => {
			res.writeHead(200, { 'content-type': 'application/json' })
			res.end(JSON.stringify({ ok: true }))
		})
		await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
		const address = server.address() as AddressInfo

		const client = createKubernetesClient({
			server: `https://127.0.0.1:${address.port}`,
			namespace: 'ns',
			getToken: async () => 't',
		})
		await expect(
			client.request('GET', '/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes'),
		).rejects.toThrow()
	})
})
