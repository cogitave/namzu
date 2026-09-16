/**
 * Readiness is bounded, and nothing survives a failed create.
 *
 * The property under test is the one a leak is made of: every way out of the
 * acquire block runs cleanup exactly once, on its own short budget, and a
 * DELETE that reports the object already gone is the state DELETE was asking
 * for rather than a second failure to report.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { ReadinessPollTimeout, buildKubernetesBackend } from '../index.js'
import {
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'

const NAMESPACE = 'namzu-sandboxes'

let server: FakeApiServer | undefined

afterEach(async () => {
	await server?.close()
	server = undefined
})

function backend(timeoutMs = 100) {
	if (!server) throw new Error('fake API server not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		readyTimeoutMs: timeoutMs,
		readyPollIntervalMs: 5,
		ingress: 'unverified' as const,
	})
}

describe('a claim that never becomes Ready', () => {
	it('expires on the caller-selected clock and deletes the claim before rejecting', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: { status: { conditions: [readyCondition('False')] } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const startedAt = performance.now()
		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/never became Ready \(100ms\)/,
		)
		// The DELETE is already recorded when the promise rejects — cleanup is
		// awaited inside the catch, not fired and forgotten.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
		expect(performance.now() - startedAt).toBeLessThan(2_000)
	})

	it('says the CLOCK ran out by type, not only in words', async () => {
		// Callers that have to choose between two timeout messages ask which
		// failure this was, and the answer cannot be a clock read: the expiry
		// timer and `performance.now()` are different clocks, and a timer that
		// fires a fraction of a millisecond early leaves a positive remainder
		// behind an expiry that has already happened. So the poll's own
		// give-up is a TYPE — see `acquireBoundPod` in `workspace.ts`, which
		// is the caller that would otherwise blame the CNI for a 5xx.
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: { status: { conditions: [readyCondition('False')] } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const error = await backend(60)
			.create({ workingDirectory: '/workspace' })
			.then(
				() => undefined,
				(err: unknown) => err,
			)

		expect(error).toBeInstanceOf(ReadinessPollTimeout)
	})

	it('polls the claim rather than watching it', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: { status: { conditions: [readyCondition('Unknown')] } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		await expect(backend(60).create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/never became Ready/,
		)
		// More than one GET, and no `?watch=` anywhere: v1 deliberately has no
		// resourceVersion tracking, bookmarks or relist to get wrong.
		expect(server.matching('GET', '/sandboxclaims/').length).toBeGreaterThan(1)
		expect(server.requests.some((r) => r.path.includes('watch'))).toBe(false)
	})

	it('gives up immediately when the controller reports Ready with no bound sandbox', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: { status: { conditions: [readyCondition()] } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const startedAt = performance.now()
		await expect(backend(5_000).create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/named no sandbox in status\.sandbox\.name/,
		)
		// A contradiction is not a "not yet": polling on would burn the whole
		// five-second budget waiting for a field the controller has finished
		// writing.
		expect(performance.now() - startedAt).toBeLessThan(1_000)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('a failure mid-poll', () => {
	it('surfaces the API error and cleans up exactly once', async () => {
		let polls = 0
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				polls += 1
				if (polls === 1) {
					return { status: 200, body: { status: { conditions: [readyCondition('False')] } } }
				}
				return { status: 500, body: { message: 'etcd leader changed' } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		await expect(backend(5_000).create({ workingDirectory: '/workspace' })).rejects.toThrow(/500/)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('keeps the primary failure when the cleanup DELETE reports the claim already gone', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 500, body: { message: 'apiserver unavailable' } }
			}
			// The TTL, an operator or the controller got there first.
			if (req.method === 'DELETE') return { status: 404, body: { message: 'gone' } }
			return { status: 404, body: {} }
		})

		// The readiness failure is what the caller sees; the 404 on cleanup is
		// success and must not replace it.
		await expect(backend(5_000).create({ workingDirectory: '/workspace' })).rejects.toThrow(/500/)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('a create that fails', () => {
	it('still deletes, because a POST that failed client-side may have committed', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 500, body: { message: 'webhook timeout' } }
			if (req.method === 'DELETE') return { status: 404, body: { message: 'gone' } }
			return { status: 404, body: {} }
		})

		await expect(backend(5_000).create({ workingDirectory: '/workspace' })).rejects.toThrow(/500/)
		// The 404 answer is the point: the object was never persisted here, and
		// that reads as released rather than as a second failure.
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})
})

describe('caller cancellation', () => {
	it('stops readiness and still releases the claim', async () => {
		server = await startFakeApiServer((req) => {
			if (req.method === 'POST') return { status: 201, body: {} }
			if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
				return { status: 200, body: { status: { conditions: [readyCondition('False')] } } }
			}
			if (req.method === 'DELETE') return { status: 200, body: {} }
			return { status: 404, body: {} }
		})

		const caller = new AbortController()
		const reason = new Error('operator stopped the run')
		const pending = backend(5_000).create({
			workingDirectory: '/workspace',
			signal: caller.signal,
		})
		while (server.matching('GET', '/sandboxclaims/').length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 1))
		}
		caller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(server.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
	})

	it('creates nothing at all when the signal is already aborted', async () => {
		server = await startFakeApiServer(() => ({ status: 200, body: {} }))
		const caller = new AbortController()
		caller.abort()

		await expect(
			backend().create({ workingDirectory: '/workspace', signal: caller.signal }),
		).rejects.toBeTruthy()
		expect(server.requests).toHaveLength(0)
	})
})

describe('readiness bounds are validated before anything is contacted', () => {
	it('refuses a non-positive timeout at construction, not on first create', async () => {
		let tokensRequested = 0
		expect(() =>
			buildKubernetesBackend({
				access: {
					server: 'http://127.0.0.1:1',
					getToken: async () => {
						tokensRequested += 1
						return 't'
					},
				},
				namespace: NAMESPACE,
				sandboxTemplateName: 'namzu-task',
				readyTimeoutMs: 0,
			}),
		).toThrow(/kubernetes\.readyTimeoutMs/)
		expect(tokensRequested).toBe(0)
	})
})
