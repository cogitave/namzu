import { type Server, createServer } from 'node:http'
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	DEFAULT_API_REQUEST_TIMEOUT_MS,
	KubernetesAlreadyGoneError,
	KubernetesApiTimeoutError,
	KubernetesConflictError,
	KubernetesCredentialError,
	KubernetesPatchNotAppliedError,
	MIN_API_REQUEST_TIMEOUT_MS,
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

	it('sends a json patch with application/json-patch+json and the operation list verbatim', async () => {
		// The dialect is the feature: a merge patch has no way to express a
		// condition, so a conditional write has to go up as RFC 6902 — and
		// the operation ORDER is part of the body, because a `test` written
		// after an `add` would be testing this patch's own work.
		const operations = [
			{ op: 'test', path: '/metadata/annotations/sandbox.namzu.ai~1holder-epoch', value: '4' },
			{ op: 'add', path: '/metadata/annotations/sandbox.namzu.ai~1holder-epoch', value: '5' },
			{ op: 'add', path: '/spec/operatingMode', value: 'Suspended' },
		]
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>
			expect(init?.method).toBe('PATCH')
			expect(headers['content-type']).toBe('application/json-patch+json')
			expect(init?.body).toBe(JSON.stringify(operations))
			return jsonResponse(200, { ok: true })
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		await client.request(
			'PATCH',
			'/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1',
			operations,
			undefined,
			'json',
		)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('maps a 422 on a json patch to KubernetesPatchNotAppliedError', async () => {
		// The body a real API server (v1.37.0, agent-sandbox `Sandbox` CRD)
		// answers an unapplied JSON patch with — identical for a failed
		// `test`, for a pointer into a member that does not exist and for a
		// `test` on an absent annotation key. The class says only what that
		// reply supports: the patch did not apply and nothing changed.
		globalThis.fetch = (async () =>
			jsonResponse(422, {
				kind: 'Status',
				apiVersion: 'v1',
				metadata: {},
				status: 'Failure',
				message: 'the server rejected our request due to an error in our request',
				reason: 'Invalid',
				details: {},
				code: 422,
			})) as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		const failure = await client
			.request(
				'PATCH',
				'/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1',
				[],
				undefined,
				'json',
			)
			.catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(KubernetesPatchNotAppliedError)
		expect((failure as KubernetesPatchNotAppliedError).status).toBe(422)
		expect((failure as KubernetesPatchNotAppliedError).method).toBe('PATCH')
		// It does not claim to know which of the two happened, because the
		// reply does not say.
		expect((failure as Error).message).toMatch(
			/either a `test` clause .* or a patch body that is wrong/,
		)
	})

	it('leaves a 422 on a MERGE patch as the plain error it always was', async () => {
		// A merge patch carries no condition, so a 422 on one is a malformed
		// body and has nothing to do with a lost race. Reading it as one
		// would send a caller re-reading an object nobody touched.
		globalThis.fetch = (async () =>
			jsonResponse(422, {
				message: 'Sandbox in version "v1beta1" cannot be handled',
			})) as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		const failure = await client
			.request('PATCH', '/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1', { spec: {} })
			.catch((err: unknown) => err)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).not.toBeInstanceOf(KubernetesPatchNotAppliedError)
		expect((failure as Error).message).toMatch(/-> 422:/)
	})

	it('sends a DELETE body as plain application/json, so preconditions travel with it', async () => {
		// A fenced delete cannot use a patch `test`; its condition is
		// `preconditions.resourceVersion` inside a `DeleteOptions` body, and
		// a DELETE body is plain JSON rather than any patch dialect.
		const deleteBody = {
			apiVersion: 'v1',
			kind: 'DeleteOptions',
			preconditions: { resourceVersion: '4271' },
		}
		const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string>
			expect(init?.method).toBe('DELETE')
			expect(headers['content-type']).toBe('application/json')
			expect(init?.body).toBe(JSON.stringify(deleteBody))
			return jsonResponse(200, { kind: 'Status' })
		})
		globalThis.fetch = fetchSpy as unknown as typeof fetch

		const client = createKubernetesClient({
			server: 'http://127.0.0.1:1',
			namespace: 'ns',
			getToken: async () => 't',
		})
		await client.request(
			'DELETE',
			'/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1',
			deleteBody,
		)
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
		let sawSocketClose = false
		const server: Server = createServer((_req, res) => {
			// Deliberately never responds; the client must give up on its own.
			void res
		})
		// Watch the raw connection, not `req.on('close'/'aborted')`. Those
		// HTTP-level events depend on the server's parser already having a
		// complete request line + headers before the socket tears down, and
		// under a fast-enough abort (10ms here, and the client's own event
		// loop can be slow to flush the request under CI load) the abort can
		// win that race: the socket connects and closes with no 'request'
		// event ever firing on the server, so `req.on('close')` would then
		// never fire — not "late", genuinely never, no matter the timeout.
		// Confirmed by instrumenting both under synthetic CPU contention:
		// the raw socket close was 100% reliable (tens of ms even at 2x
		// core oversubscription) while the HTTP-level close/aborted events
		// fired only when the request happened to beat the abort onto the
		// wire. The socket closing is exactly what "no pending request"
		// means here — the connection this abort opened does not linger —
		// and it's the one thing this transport actually guarantees.
		server.on('connection', (socket) => {
			socket.on('close', () => {
				sawSocketClose = true
			})
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
			// The contract this backend promises: the client gives up on its own,
			// promptly, once aborted. That's proven above and stays a tight bound.
			expect(Date.now() - started).toBeLessThan(2_000)
			// The socket teardown itself is fast in practice (tens of ms, even
			// under heavy CPU contention — verified manually), but *when* this
			// process's event loop gets around to running it depends on how
			// contended the host is, same as any other socket callback, so this
			// stays a generous bound rather than coupling to host load. The
			// test-level timeout below is raised to match, so a slow-but-healthy
			// run isn't cut off by vitest's default 5s budget first.
			await vi.waitFor(() => expect(sawSocketClose).toBe(true), { timeout: 15_000 })
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()))
		}
	}, 20_000)
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

/**
 * The bound the client puts on every request of its own.
 *
 * The caller's signal is optional everywhere in this backend and several of
 * its requests are single-flight promises that run under whichever caller
 * arrived first, so "callers should pass a signal" was never enough: one
 * signal-less `destroy()` against an API server that accepted a request and
 * never answered pinned every later caller joined to it.
 *
 * Every case here uses a REAL listener that completes its handshake and then
 * says nothing, rather than a stubbed `fetch` that resolves late: what is
 * under test is that the client gives up on a socket it is holding open.
 */
describe('createKubernetesClient — the per-request bound', () => {
	const TOKEN = 'super-secret-bearer-value'
	const BOUND_MS = MIN_API_REQUEST_TIMEOUT_MS
	let plain: Server | undefined
	let secure: HttpsServer | undefined

	afterEach(async () => {
		if (plain) await new Promise<void>((resolve) => plain?.close(() => resolve()))
		if (secure) await new Promise<void>((resolve) => secure?.close(() => resolve()))
		plain = undefined
		secure = undefined
	})

	/** A server that accepts, reads the request, and never answers it. */
	async function startSilent(kind: 'plain' | 'secure'): Promise<string> {
		const held: import('node:net').Socket[] = []
		const onRequest = (req: import('node:http').IncomingMessage) => {
			held.push(req.socket)
		}
		if (kind === 'plain') {
			plain = createServer(onRequest)
			await new Promise<void>((resolve) => plain?.listen(0, '127.0.0.1', resolve))
			return `http://127.0.0.1:${(plain.address() as AddressInfo).port}`
		}
		secure = createHttpsServer({ cert: SERVER_CRT, key: SERVER_KEY }, onRequest)
		await new Promise<void>((resolve) => secure?.listen(0, '127.0.0.1', resolve))
		return `https://127.0.0.1:${(secure.address() as AddressInfo).port}`
	}

	it('pins the default and the floor', () => {
		expect(DEFAULT_API_REQUEST_TIMEOUT_MS).toBe(30_000)
		expect(MIN_API_REQUEST_TIMEOUT_MS).toBe(1_000)
	})

	it.each([
		['fetch', 'plain'],
		['node:https', 'secure'],
	] as const)(
		'rejects a signal-less request with a named timeout on the %s path',
		async (_label, kind) => {
			const server = await startSilent(kind)
			const client = createKubernetesClient(
				{
					server,
					namespace: 'ns',
					getToken: async () => TOKEN,
					...(kind === 'secure' ? { ca: CA_CRT } : {}),
				},
				{ requestTimeoutMs: BOUND_MS },
			)
			const resource = '/apis/agents.x-k8s.io/v1/namespaces/ns/sandboxes/s1'
			const started = Date.now()
			const failure = await client.request('PATCH', resource, { spec: {} }).then(
				() => undefined,
				(err: unknown) => err,
			)
			expect(failure).toBeInstanceOf(KubernetesApiTimeoutError)
			expect(failure).toMatchObject({ verb: 'PATCH', resource, timeoutMs: BOUND_MS })
			const elapsed = Date.now() - started
			expect(elapsed).toBeGreaterThanOrEqual(BOUND_MS - 50)
			expect(elapsed).toBeLessThan(BOUND_MS * 4)
			// Not the generic `failed:` wrapper, and never the credential.
			const message = failure instanceof Error ? failure.message : String(failure)
			expect(message).not.toContain('failed:')
			expect(message).not.toContain(TOKEN)
			expect(message).toContain('apiRequestTimeoutMs')
		},
		20_000,
	)

	it('bounds a getToken() that never resolves', async () => {
		const fetchSpy = vi.fn(async () => jsonResponse(200, {}))
		globalThis.fetch = fetchSpy as unknown as typeof fetch
		const client = createKubernetesClient(
			{
				server: 'http://127.0.0.1:1',
				namespace: 'ns',
				getToken: () => new Promise<string>(() => {}),
			},
			{ requestTimeoutMs: BOUND_MS },
		)
		const failure = await client.request('GET', '/apis/x/v1/namespaces/ns/sandboxes').then(
			() => undefined,
			(err: unknown) => err,
		)
		expect(failure).toBeInstanceOf(KubernetesApiTimeoutError)
		// It never got as far as a request, which is the point: the token
		// callback used not to be inside any bound at all.
		expect(fetchSpy).not.toHaveBeenCalled()
	}, 20_000)

	it("leaves a caller's own abort exactly as it was", async () => {
		const server = await startSilent('plain')
		const client = createKubernetesClient(
			{ server, namespace: 'ns', getToken: async () => TOKEN },
			// Far above the abort, so a timeout cannot be what ends this.
			{ requestTimeoutMs: 20_000 },
		)
		const controller = new AbortController()
		setTimeout(() => controller.abort(), 20)
		const failure = await client
			.request('GET', '/apis/x/v1/namespaces/ns/sandboxes', undefined, controller.signal)
			.then(
				() => undefined,
				(err: unknown) => err,
			)
		expect(failure).toBeInstanceOf(Error)
		expect(failure).not.toBeInstanceOf(KubernetesApiTimeoutError)
	}, 30_000)

	it('lets a caller abort win over a bound that has not expired', async () => {
		const server = await startSilent('plain')
		const client = createKubernetesClient(
			{ server, namespace: 'ns', getToken: async () => TOKEN },
			{ requestTimeoutMs: BOUND_MS },
		)
		const controller = new AbortController()
		controller.abort(new Error('caller gave up'))
		await expect(
			client.request('GET', '/apis/x/v1/namespaces/ns/sandboxes', undefined, controller.signal),
		).rejects.toThrow('caller gave up')
	}, 20_000)

	it.each([0, -1, 999, 1.5, Number.NaN])(
		'refuses %p at construction — there is no disabling value',
		(value) => {
			expect(() =>
				createKubernetesClient(
					{ server: 'http://127.0.0.1:1', namespace: 'ns', getToken: async () => TOKEN },
					{ requestTimeoutMs: value },
				),
			).toThrow(/apiRequestTimeoutMs/)
		},
	)

	it('answers a healthy server well inside the bound', async () => {
		globalThis.fetch = vi.fn(async () => jsonResponse(200, { ok: true })) as unknown as typeof fetch
		const client = createKubernetesClient(
			{ server: 'http://127.0.0.1:1', namespace: 'ns', getToken: async () => TOKEN },
			{ requestTimeoutMs: BOUND_MS },
		)
		await expect(client.request('GET', '/apis/x/v1/namespaces/ns/sandboxes')).resolves.toEqual({
			ok: true,
		})
	})
})
