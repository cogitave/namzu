/**
 * Lease renewal: the timer the Sandbox handle owns, and what each outcome
 * does to the handle.
 *
 * The defect this exists to close is silent in exactly the way the
 * cold-start trap is: acquire stamps an absolute `shutdownTime` on every
 * object it creates, nothing renewed it, and so a run that outlived
 * `claimTtlSeconds` had its pod deleted underneath it mid-command. Every
 * functional test passed, because every functional test finishes in
 * milliseconds.
 *
 * The API-server-level cases below therefore assert the PATCH on the wire —
 * which path, which field, and that the new expiry is genuinely later than
 * the one the create POSTed — rather than that some method was called.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { OperationDeadlineExpired } from '../../readiness.js'
import { buildKubernetesBackend } from '../index.js'
import { KubernetesAlreadyGoneError } from '../k8s-client.js'
import { KubernetesLeaseRenewal, jitteredInterval } from '../lease.js'
import { buildKubernetesSandbox } from '../sandbox.js'
import { KubernetesAgentTransport } from '../transport.js'
import {
	type FakeApiReply,
	type FakeApiServer,
	readyCondition,
	startFakeApiServer,
} from './fixtures/fake-api-server.js'
import {
	PRIVILEGED_PROC_STATUS,
	type ScriptedAgent,
	startScriptedAgent,
} from './fixtures/scripted-agent.js'

const NAMESPACE = 'namzu-sandboxes'
const SANDBOX_NAME = 'namzu-task-pool-sandbox-4de19'
const POD_UID = '9c4e1f77-2a18-4ff0-8f1c-6d2b0f0a55e1'

let server: FakeApiServer | undefined
let agent: ScriptedAgent | undefined
let lease: KubernetesLeaseRenewal | undefined

afterEach(async () => {
	vi.useRealTimers()
	lease?.stop()
	lease = undefined
	await server?.close()
	await agent?.close()
	server = undefined
	agent = undefined
})

describe('the renewal loop', () => {
	it('pushes the expiry a full TTL forward on every tick', async () => {
		const stamps: string[] = []
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 600,
			intervalMs: 5,
			renew: async (shutdownTime) => {
				stamps.push(shutdownTime)
			},
			onGone: () => {},
		})
		lease.start()

		await vi.waitFor(() => expect(stamps.length).toBeGreaterThanOrEqual(2))
		for (const stamp of stamps) {
			const at = Date.parse(stamp)
			expect(Number.isNaN(at)).toBe(false)
			// A full TTL ahead of NOW, not of the original stamp: the point is
			// that the object never gets within a half-TTL of expiring.
			expect(at).toBeGreaterThan(Date.now() + 500_000)
		}
		// Ticks are strictly increasing — each one re-reads the clock.
		expect(Date.parse(stamps[1] as string)).toBeGreaterThanOrEqual(Date.parse(stamps[0] as string))
	})

	it('stops when told to, and stays stopped', async () => {
		let calls = 0
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 600,
			intervalMs: 5,
			renew: async () => {
				calls += 1
			},
			onGone: () => {},
		})
		lease.start()
		await vi.waitFor(() => expect(calls).toBeGreaterThan(0))

		lease.stop()
		const observed = calls
		await new Promise((resolve) => setTimeout(resolve, 60))
		expect(calls).toBe(observed)
		expect(lease.active).toBe(false)
		// A start() after stop() does not resurrect it: the handle that
		// stopped it is done with it.
		lease.start()
		await new Promise((resolve) => setTimeout(resolve, 40))
		expect(calls).toBe(observed)
	})

	it('retries a failed renewal on a growing backoff, then resumes the half-TTL cadence after success', async () => {
		vi.useFakeTimers()
		const errors: unknown[] = []
		let attempts = 0
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 3_600,
			// No jitter: the delays below are then exact, not a ±10% range.
			random: () => 0.5,
			renew: async () => {
				attempts += 1
				if (attempts <= 2) throw new Error('apiserver unavailable')
			},
			onGone: () => {},
			onRenewalError: (error) => errors.push(error),
		})
		lease.start()

		// The first attempt is the ordinary half-TTL tick, not a retry.
		await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1)
		expect(attempts).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(attempts).toBe(1)
		expect(errors).toHaveLength(1)
		expect((errors[0] as Error).message).toBe('apiserver unavailable')

		// First failure: retried on the one-second backoff floor, nowhere
		// near waiting out another half-TTL.
		await vi.advanceTimersByTimeAsync(999)
		expect(attempts).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(attempts).toBe(2)
		expect(errors).toHaveLength(2)

		// Second consecutive failure: the backoff doubles to two seconds.
		await vi.advanceTimersByTimeAsync(1_999)
		expect(attempts).toBe(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(attempts).toBe(3)
		expect(lease.active).toBe(true)

		// The third attempt succeeds — the backoff resets and the NEXT tick
		// is a half-TTL away again, not another short retry.
		await vi.advanceTimersByTimeAsync(30 * 60 * 1_000 - 1)
		expect(attempts).toBe(3)
		await vi.advanceTimersByTimeAsync(1)
		expect(attempts).toBe(4)
	})

	it('caps the backoff instead of doubling forever', async () => {
		vi.useFakeTimers()
		const gaps: number[] = []
		let last: number | undefined
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 3_600,
			random: () => 0.5,
			renew: async () => {
				const now = Date.now()
				if (last !== undefined) gaps.push(now - last)
				last = now
				throw new Error('still unavailable')
			},
			onGone: () => {},
			onRenewalError: () => {},
		})
		lease.start()

		await vi.advanceTimersByTimeAsync(30 * 60 * 1_000) // the first, on-time tick
		// 1s, 2s, 4s, 8s, 16s would keep doubling past the 30s ceiling — the
		// three ticks after that must all land at exactly the cap.
		const schedule = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]
		for (const delay of schedule) {
			await vi.advanceTimersByTimeAsync(delay)
		}

		expect(gaps).toEqual(schedule)
	})

	it('stops immediately on gone while retrying on a backoff', async () => {
		vi.useFakeTimers()
		let attempts = 0
		let gone = 0
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 3_600,
			random: () => 0.5,
			renew: async () => {
				attempts += 1
				if (attempts === 1) throw new Error('apiserver unavailable')
				throw new KubernetesAlreadyGoneError('PATCH', '/apis/…/sandboxclaims/x', 404)
			},
			onGone: () => {
				gone += 1
			},
		})
		lease.start()

		await vi.advanceTimersByTimeAsync(30 * 60 * 1_000) // first tick: fails
		expect(attempts).toBe(1)
		await vi.advanceTimersByTimeAsync(1_000) // backoff floor: second attempt, gone
		expect(attempts).toBe(2)
		expect(gone).toBe(1)
		expect(lease.active).toBe(false)

		// Nothing is scheduled behind it — no further attempt, ever.
		await vi.advanceTimersByTimeAsync(60 * 60 * 1_000)
		expect(attempts).toBe(2)
	})

	it('acceptance: a two-minute outage around the scheduled renewal never lets the claim expire', async () => {
		vi.useFakeTimers()
		const start = Date.now()
		const outageStart = start + 30 * 60 * 1_000
		const outageEnd = outageStart + 2 * 60 * 1_000
		const attemptsAt: number[] = []
		let succeededAt: number | undefined
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 3_600,
			random: () => 0.5,
			renew: async () => {
				const now = Date.now()
				attemptsAt.push(now)
				if (now >= outageStart && now < outageEnd) {
					throw new Error('apiserver unavailable')
				}
				succeededAt = now
			},
			onGone: () => {},
			onRenewalError: () => {},
		})
		lease.start()

		// Run out the whole TTL: if the claim's own expiry were ever reached
		// unrenewed, nothing here would notice it — the assertions below are
		// what actually prove a renewal landed before it.
		await vi.advanceTimersByTimeAsync(3_600_000)

		const duringOutage = attemptsAt.filter((at) => at >= outageStart && at < outageEnd)
		// More than one retry landed inside the two-minute window — the old
		// half-TTL-per-retry behaviour would have landed exactly one attempt
		// (the on-time tick) and then waited another full TTL.
		expect(duringOutage.length).toBeGreaterThan(1)
		// A renewal succeeded well before the object's real expiry (a full
		// TTL after the run started, since this is the first renewal).
		expect(succeededAt).toBeDefined()
		expect(succeededAt as number).toBeLessThan(start + 3_600_000)
		expect(lease.active).toBe(true)
	})

	it('acceptance: continuous failure across the whole TTL retries at the backoff floor and is marked gone only on 404/410', async () => {
		vi.useFakeTimers()
		const errors: unknown[] = []
		const attemptsAt: number[] = []
		let gone = 0
		let goneNow = false
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 3_600,
			random: () => 0.5,
			renew: async () => {
				attemptsAt.push(Date.now())
				if (goneNow) throw new KubernetesAlreadyGoneError('PATCH', '/apis/…/sandboxclaims/x', 410)
				throw new Error('apiserver unavailable')
			},
			onGone: () => {
				gone += 1
			},
			onRenewalError: (error) => errors.push(error),
		})
		lease.start()

		await vi.advanceTimersByTimeAsync(3_600_000)

		// Every attempt reported, and the loop never went gone on its own —
		// only a 404/410 does that, and this API never returned one.
		expect(attemptsAt.length).toBeGreaterThan(1)
		expect(errors).toHaveLength(attemptsAt.length)
		expect(gone).toBe(0)
		expect(lease.active).toBe(true)
		// The floor: no retry (i.e. every gap after the first, on-time tick)
		// ever lands sooner than the one-second backoff floor.
		for (let i = 2; i < attemptsAt.length; i++) {
			expect((attemptsAt[i] as number) - (attemptsAt[i - 1] as number)).toBeGreaterThanOrEqual(
				1_000,
			)
		}

		// Positive control: once the API starts saying the object is gone,
		// the very next attempt marks the handle gone and stops the loop —
		// proving the assertions above are not vacuously true.
		goneNow = true
		await vi.advanceTimersByTimeAsync(30_000)
		expect(gone).toBe(1)
		expect(lease.active).toBe(false)
	})

	it('abandons a renewal that hangs, reports it, and retries on a backoff', async () => {
		vi.useFakeTimers()
		const errors: unknown[] = []
		let attempts = 0
		let abandoned = false
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 600,
			intervalMs: 5,
			patchTimeoutMs: 20,
			random: () => 0.5,
			renew: async (_shutdownTime, signal) => {
				attempts += 1
				if (attempts > 1) return
				// A PATCH that got a connection and never got an answer.
				// NOTHING settles this promise: if the tick does not bound the
				// call itself, the loop parks here forever — the next tick is
				// scheduled only after this await returns — and the lease then
				// expires in total silence, which is the failure this whole
				// file exists to prevent.
				signal?.addEventListener('abort', () => {
					abandoned = true
				})
				await new Promise<never>(() => {})
			},
			onGone: () => {},
			onRenewalError: (error) => errors.push(error),
		})
		lease.start()

		await vi.advanceTimersByTimeAsync(5) // base interval: first tick fires
		expect(attempts).toBe(1)
		await vi.advanceTimersByTimeAsync(20) // patch timeout: the hang is abandoned
		expect(errors).toHaveLength(1)
		expect(errors[0]).toBeInstanceOf(OperationDeadlineExpired)
		// And the abandoned call was told, so its socket is released rather
		// than left to the peer or the OS.
		expect(abandoned).toBe(true)

		// Retried on the one-second backoff floor, not another 5ms tick.
		await vi.advanceTimersByTimeAsync(999)
		expect(attempts).toBe(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(attempts).toBe(2)
		expect(lease.active).toBe(true)
	})

	it('stops and reports gone when the object has been deleted', async () => {
		let calls = 0
		let gone = 0
		lease = new KubernetesLeaseRenewal({
			ttlSeconds: 600,
			intervalMs: 5,
			renew: async () => {
				calls += 1
				throw new KubernetesAlreadyGoneError('PATCH', '/apis/…/sandboxclaims/x', 404)
			},
			onGone: () => {
				gone += 1
			},
		})
		lease.start()

		await vi.waitFor(() => expect(gone).toBe(1))
		const observed = calls
		await new Promise((resolve) => setTimeout(resolve, 60))
		// Nothing brings a deleted object back, so the loop does not keep
		// asking.
		expect(calls).toBe(observed)
		expect(lease.active).toBe(false)
	})
})

describe('the jitter', () => {
	it('spreads a synchronised fleet by ±10% and never schedules a zero delay', () => {
		expect(jitteredInterval(1_000, () => 0)).toBe(900)
		expect(jitteredInterval(1_000, () => 1)).toBe(1_100)
		expect(jitteredInterval(1_000, () => 0.5)).toBe(1_000)
		// A zero-delay chain would spin; the floor is one millisecond.
		expect(jitteredInterval(0, () => 0)).toBe(1)
	})
})

// ---------------------------------------------------------------------------
// Through the backend, against a real HTTP API server.
// ---------------------------------------------------------------------------

interface ServerOptions {
	readonly patchStatus?: number
	readonly pool?: boolean
	/** Accept the PATCH and never answer it — a stalled API server. */
	readonly hangPatch?: boolean
}

function apiServer(options: ServerOptions = {}): Promise<FakeApiServer> {
	const pool = options.pool !== false
	return startFakeApiServer((req) => {
		if (req.method === 'PATCH' && options.hangPatch === true) {
			return new Promise<FakeApiReply>(() => {})
		}
		if (req.method === 'GET' && req.path.includes('/sandboxtemplates/')) {
			return {
				status: 200,
				body: {
					metadata: { name: 'namzu-task' },
					spec: { podTemplate: { spec: { containers: [{ name: 'main', image: 'x' }] } } },
				},
			}
		}
		if (req.method === 'POST') return { status: 201, body: {} }
		if (req.method === 'PATCH') {
			return { status: options.patchStatus ?? 200, body: { message: 'patched' } }
		}
		if (req.method === 'GET' && req.path.includes('/sandboxclaims/')) {
			return {
				status: 200,
				body: {
					status: {
						conditions: [readyCondition()],
						sandbox: { name: SANDBOX_NAME, serviceFQDN: '127.0.0.1' },
					},
				},
			}
		}
		if (!pool && req.method === 'GET' && req.path.includes('/sandboxes/')) {
			const name = req.path.split('/sandboxes/')[1] ?? ''
			return {
				status: 200,
				body: {
					metadata: { name },
					status: { conditions: [readyCondition()], serviceFQDN: '127.0.0.1' },
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

function backend(overrides: Record<string, unknown> = {}) {
	if (!server || !agent) throw new Error('fixtures not started')
	return buildKubernetesBackend({
		access: { server: server.url, getToken: async () => 'sa-token' },
		namespace: NAMESPACE,
		sandboxTemplateName: 'namzu-task',
		warmPoolName: 'namzu-task-pool',
		agentPort: agent.port,
		// One second, so the half-TTL tick lands inside a test's patience.
		claimTtlSeconds: 1,
		readyTimeoutMs: 2_000,
		readyPollIntervalMs: 5,
		...overrides,
	})
}

describe('the lease is configured as a pair or not at all', () => {
	it('refuses a renewal with no TTL to stamp', () => {
		// A renewal re-stamps `now + ttlSeconds`, so a zero or absent TTL
		// stamps an expiry that has already passed: the controller reaps the
		// object while the loop reports every tick a success — a lease that
		// deletes the thing it was added to protect. The options type pairs
		// the two fields; this is the same rule at runtime, for a caller that
		// arrived through a cast or from JavaScript.
		const options = {
			name: SANDBOX_NAME,
			rootDir: '/workspace',
			transport: new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port: 1,
				token: POD_UID,
			}),
			release: async () => undefined,
			renew: async () => undefined,
		}
		expect(() => buildKubernetesSandbox(options as never)).toThrow(/positive ttlSeconds/)
		expect(() => buildKubernetesSandbox({ ...options, ttlSeconds: 0 } as never)).toThrow(
			/positive ttlSeconds/,
		)
	})

	it('builds a handle with no lease at all when there is no expiry to move', () => {
		// The workspace's shape: explicitly managed, no `shutdownTime`, and so
		// no timer. A no-op `renew` would be the wrong way to say it.
		const sandbox = buildKubernetesSandbox({
			name: SANDBOX_NAME,
			rootDir: '/workspace',
			transport: new KubernetesAgentTransport({
				kind: 'tcp',
				host: '127.0.0.1',
				port: 1,
				token: POD_UID,
			}),
			release: async () => undefined,
		})
		expect(sandbox.status).toBe('ready')
	})
})

describe('a handle renews its own lease', () => {
	it('PATCHes the claim it created, moving shutdownTime later', async () => {
		server = await apiServer()
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		await vi.waitFor(() => expect(server?.matching('PATCH', '/sandboxclaims/').length).toBe(1), {
			timeout: 3_000,
		})
		const created = server.matching('POST', '/sandboxclaims')[0]?.body as {
			metadata: { name: string }
			spec: { lifecycle: { shutdownTime: string; shutdownPolicy: string } }
		}
		const renewal = server.matching('PATCH', '/sandboxclaims/')[0] as {
			path: string
			body: { spec: { lifecycle: { shutdownTime: string } } }
		}

		// The object this backend created, by its own client-owned name.
		expect(renewal.path).toContain(created.metadata.name)
		// Only the expiry moves. A merge patch of the nested object leaves
		// shutdownPolicy: Delete — the leak guard — exactly where it was.
		expect(Object.keys(renewal.body.spec)).toEqual(['lifecycle'])
		expect(Object.keys(renewal.body.spec.lifecycle)).toEqual(['shutdownTime'])
		expect(Date.parse(renewal.body.spec.lifecycle.shutdownTime)).toBeGreaterThan(
			Date.parse(created.spec.lifecycle.shutdownTime),
		)
		await sandbox.destroy()
	})

	it('PATCHes spec.shutdownTime on a directly created Sandbox, where that field lives', async () => {
		server = await apiServer({ pool: false })
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend({ warmPoolName: undefined }).create({
			workingDirectory: '/workspace',
		})

		await vi.waitFor(() => expect(server?.matching('PATCH', '/sandboxes/').length).toBe(1), {
			timeout: 3_000,
		})
		const renewal = server.matching('PATCH', '/sandboxes/')[0]?.body as {
			spec: Record<string, unknown>
		}
		// v1beta1 as served keeps a Sandbox's expiry at the top of spec, not
		// under a `lifecycle` block; patching the wrong path would be a
		// successful no-op that renews nothing.
		expect(Object.keys(renewal.spec)).toEqual(['shutdownTime'])
		await sandbox.destroy()
	})

	it('stops renewing once the handle is destroyed', async () => {
		server = await apiServer()
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		await vi.waitFor(() => expect(server?.matching('PATCH', '/').length).toBeGreaterThan(0), {
			timeout: 3_000,
		})
		await sandbox.destroy()
		const observed = server.matching('PATCH', '/').length
		// Several intervals' worth of silence: a destroyed handle that kept
		// renewing would keep an object alive that nothing owns.
		await new Promise((resolve) => setTimeout(resolve, 1_500))
		expect(server.matching('PATCH', '/').length).toBe(observed)
	})

	it('survives a failing renewal: it is reported, not thrown out of the handle', async () => {
		const errors: unknown[] = []
		server = await apiServer({ patchStatus: 500 })
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend({ onLeaseRenewalError: (e: unknown) => errors.push(e) }).create({
			workingDirectory: '/workspace',
		})

		await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1), { timeout: 3_000 })
		expect((errors[0] as Error).message).toMatch(/500/)
		// The sandbox is untouched by a renewal that failed — there is still
		// half a TTL before anything expires, and the next tick retries.
		expect(sandbox.status).toBe('ready')
		await expect(sandbox.exec('cat', ['/proc/self/status'])).resolves.toMatchObject({
			exitCode: 0,
		})
		await sandbox.destroy()
	})

	it('keeps renewing when the API server accepts a PATCH and never answers it', async () => {
		const errors: unknown[] = []
		server = await apiServer({ hangPatch: true })
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend({ onLeaseRenewalError: (e: unknown) => errors.push(e) }).create({
			workingDirectory: '/workspace',
		})

		// Two PATCHes on the wire is the whole point: the first one is still
		// hanging, so the second one only exists because the tick abandoned
		// it on its own clock. Unbounded, this reaches one and stops there,
		// with nothing reported and the object quietly expiring later.
		await vi.waitFor(
			() => expect(server?.matching('PATCH', '/').length).toBeGreaterThanOrEqual(2),
			{
				timeout: 5_000,
			},
		)
		expect(errors.length).toBeGreaterThanOrEqual(1)
		expect(errors[0]).toBeInstanceOf(OperationDeadlineExpired)
		expect(sandbox.status).toBe('ready')
		await sandbox.destroy()
	})

	it('leaves no renewal running behind a create() the probe refused', async () => {
		server = await apiServer()
		agent = await startScriptedAgent({ token: POD_UID, stdout: PRIVILEGED_PROC_STATUS })

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrowError(
			expect.objectContaining({ name: 'KubernetesPrivilegeProbeError' }),
		)

		// The handle starts its lease before the probe runs and no caller ever
		// receives it, so the only thing that can stop the timer is create()'s
		// own cleanup path. At a 1 s TTL a surviving loop PATCHes twice inside
		// this wait — renewing an object that was already deleted, on behalf
		// of a sandbox nobody holds.
		await new Promise((resolve) => setTimeout(resolve, 1_200))
		expect(server.matching('PATCH', '/')).toHaveLength(0)
	})

	it('marks the handle gone when the object has been deleted, and names it in the refusal', async () => {
		server = await apiServer({ patchStatus: 410 })
		agent = await startScriptedAgent({ token: POD_UID })
		const sandbox = await backend().create({ workingDirectory: '/workspace' })

		await vi.waitFor(() => expect(sandbox.status).toBe('destroyed'), { timeout: 3_000 })
		// Not a dial into a connect timeout with nothing to explain it: the
		// error says the cluster removed the object and what to do about it.
		await expect(sandbox.exec('cat')).rejects.toThrowError(
			expect.objectContaining({ name: 'KubernetesSandboxGoneError' }),
		)
		await expect(sandbox.readFile('/x')).rejects.toThrow(/no longer exists on the cluster/)
		// And the loop stopped: nothing brings a deleted object back.
		const observed = server.matching('PATCH', '/').length
		await new Promise((resolve) => setTimeout(resolve, 1_200))
		expect(server.matching('PATCH', '/').length).toBe(observed)
		await sandbox.destroy()
	})
})
