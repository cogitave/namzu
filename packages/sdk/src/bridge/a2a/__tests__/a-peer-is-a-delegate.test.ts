import { describe, expect, it, vi } from 'vitest'

import { DelegatingTaskScheduler } from '../../../scheduler/delegating.js'
import { taskFailed, taskSucceeded } from '../../../tools/coordinator/outcome.js'
import type { A2AAgentCard } from '../../../types/a2a/index.js'
import type { CreateTaskOptions } from '../../../types/agent/scheduler.js'
import {
	A2ADelegate,
	A2AProtocolMismatchError,
	A2ARequestError,
	type FetchLike,
	InvalidAgentCardError,
	fetchAgentCard,
} from '../client.js'

/**
 * A peer is a delegate.
 *
 * The A2A bridge served a card and answered `message/send`, and could read
 * nobody else's — a one-way door. So the delegate seam had no driven
 * consumer, and a seam with no caller is an untested guess at what a caller
 * needs. This is the caller, and the last test is the point of the whole
 * exercise: a remote peer reaching the delegation predicates correctly,
 * through the scheduler, with nothing above it aware of the difference.
 */

const CARD: A2AAgentCard = {
	name: 'The Analyst',
	description: 'reads spreadsheets',
	version: '1.0.0',
	protocolVersion: '0.3.0',
	capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
	defaultInputModes: ['text'],
	defaultOutputModes: ['text'],
	skills: [],
	supportedInterfaces: [{ url: 'https://peer.example/a2a/analyst', transport: 'jsonrpc' }],
}

const ok = (body: unknown) => ({
	ok: true,
	status: 200,
	json: async () => body,
	text: async () => JSON.stringify(body),
})

function deferred<T>(): {
	readonly promise: Promise<T>
	readonly resolve: (value: T) => void
	readonly reject: (reason?: unknown) => void
} {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
	} catch (err) {
		return err
	}
	throw new Error('Expected the promise to reject')
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs = 100): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const safety = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error('operation did not settle')), timeoutMs)
	})
	try {
		return await Promise.race([promise, safety])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

const task = (state: string, over: Record<string, unknown> = {}) => ({
	id: 'task-1',
	status: { state, ...(over.status as object) },
	...over,
})

/** A peer that answers a scripted sequence, and records what it was asked. */
interface RecordedCall {
	method: string
	// Loose on purpose: this is the wire body a test wants to poke at, and
	// mirroring the JSON-RPC envelope as a type here would be a second
	// declaration of a shape the client already owns.
	body: {
		method?: string
		params?: { id?: string; message?: { parts: { text: string }[] } }
	}
}

function peer(replies: unknown[]): { fetch: FetchLike; calls: RecordedCall[] } {
	const calls: RecordedCall[] = []
	let index = 0
	const fetch: FetchLike = async (_url, init) => {
		const body = (init?.body ? JSON.parse(init.body) : {}) as RecordedCall['body']
		calls.push({ method: body.method ?? 'GET', body })
		const reply = replies[Math.min(index, replies.length - 1)]
		index += 1
		return ok({ jsonrpc: '2.0', id: '1', result: reply })
	}
	return { fetch, calls }
}

const delegate = (
	fetch: FetchLike,
	over: Partial<ConstructorParameters<typeof A2ADelegate>[0]> = {},
) => new A2ADelegate({ id: 'analyst', card: CARD, fetch, pollIntervalMs: 1, ...over })

const request = { prompt: 'summarise Q3', workingDirectory: '/tmp/x' }

describe('reading a peer’s card', () => {
	it('reads it from the well-known path', async () => {
		let asked: string | undefined
		const card = await fetchAgentCard('https://peer.example/', {
			fetch: async (url) => {
				asked = url
				return ok(CARD)
			},
		})

		expect(asked).toBe('https://peer.example/.well-known/agent-card.json')
		expect(card.name).toBe('The Analyst')
	})

	it('refuses a card that is not one', async () => {
		// Not a peer with quirks — an unknown service at a URL somebody typed.
		await expect(
			fetchAgentCard('https://peer.example', { fetch: async () => ok({ hello: 'world' }) }),
		).rejects.toThrow(InvalidAgentCardError)
	})

	it('refuses a null discovery body as an unknown service', async () => {
		await expect(
			fetchAgentCard('https://peer.example', { fetch: async () => ok(null) }),
		).rejects.toThrow(InvalidAgentCardError)
	})

	it('refuses a card offering no interface to reach it on', async () => {
		await expect(
			fetchAgentCard('https://peer.example', {
				fetch: async () => ok({ ...CARD, supportedInterfaces: [] }),
			}),
		).rejects.toThrow(/supportedInterfaces is empty/)
	})

	it('refuses an HTTP error rather than reading the body', async () => {
		await expect(
			fetchAgentCard('https://peer.example', {
				fetch: async () => ({
					ok: false,
					status: 404,
					json: async () => CARD,
					text: async () => '',
				}),
			}),
		).rejects.toThrow(/HTTP 404/)
	})

	it('refuses a protocol version this kernel does not implement', async () => {
		// Found once, at wiring time, which is the only moment a human is
		// looking. Degrade here and the failure moves into the middle of a
		// delegation with a run waiting on it.
		await expect(
			fetchAgentCard('https://peer.example', {
				fetch: async () => ok({ ...CARD, protocolVersion: '0.9.0' }),
			}),
		).rejects.toThrow(A2AProtocolMismatchError)
	})

	it('accepts a patch difference', async () => {
		// A2A is pre-1.0, where the MINOR carries breaking changes. Matching
		// the full string would refuse a peer over a patch bump that changes
		// nothing.
		const card = await fetchAgentCard('https://peer.example', {
			fetch: async () => ok({ ...CARD, protocolVersion: '0.3.7' }),
		})

		expect(card.protocolVersion).toBe('0.3.7')
	})

	it('accepts a card that states no version at all', async () => {
		const { protocolVersion: _dropped, ...noVersion } = CARD
		const card = await fetchAgentCard('https://peer.example', {
			fetch: async () => ok(noVersion),
		})

		expect(card.name).toBe('The Analyst')
	})

	it('does not start discovery after the caller already withdrew authority', async () => {
		const reason = new Error('operator stopped discovery')
		const controller = new AbortController()
		controller.abort(reason)
		let fetches = 0

		const failure = await rejectionOf(
			fetchAgentCard('https://peer.example', {
				fetch: async () => {
					fetches += 1
					return ok(CARD)
				},
				signal: controller.signal,
			}),
		)

		expect(failure).toBe(reason)
		expect(fetches).toBe(0)
	})

	it('bounds a non-cooperative card fetch and aborts only its private transport', async () => {
		const caller = new AbortController()
		let transport: AbortSignal | undefined
		const pending = fetchAgentCard('https://peer.example', {
			fetch: async (_url, init) => {
				transport = init?.signal
				return await new Promise<never>(() => {})
			},
			signal: caller.signal,
			timeoutMs: 5,
		})

		const failure = await rejectionOf(settleWithin(pending))

		expect(failure).toMatchObject({ name: 'TimeoutError' })
		expect(transport?.aborted).toBe(true)
		expect(transport?.reason).toBe(failure)
		expect(caller.signal.aborted).toBe(false)
	})

	it('bounds a stalled card response body, not only the fetch handshake', async () => {
		let transport: AbortSignal | undefined
		const failure = await rejectionOf(
			settleWithin(
				fetchAgentCard('https://peer.example', {
					fetch: async (_url, init) => {
						transport = init?.signal
						return {
							ok: true,
							status: 200,
							json: async () => await new Promise<never>(() => {}),
							text: async () => '',
						}
					},
					timeoutMs: 5,
				}),
			),
		)

		expect(failure).toMatchObject({ name: 'TimeoutError' })
		expect(transport?.reason).toBe(failure)
	})

	it('preserves a later caller cancellation over transport AbortError', async () => {
		const caller = new AbortController()
		const reason = new Error('wiring was abandoned')
		let transport: AbortSignal | undefined
		const pending = fetchAgentCard('https://peer.example', {
			fetch: (_url, init) => {
				transport = init?.signal
				return new Promise<never>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => {
						reject(new DOMException('transport closed', 'AbortError'))
					})
				})
			},
			signal: caller.signal,
		})

		caller.abort(reason)
		const failure = await rejectionOf(settleWithin(pending))

		expect(failure).toBe(reason)
		expect(transport?.reason).toBe(reason)
	})

	it('has a finite discovery default and an explicit unbounded compatibility option', async () => {
		vi.useFakeTimers()
		try {
			let defaultSignal: AbortSignal | undefined
			const defaultRequest = fetchAgentCard('https://peer.example', {
				fetch: async (_url, init) => {
					defaultSignal = init?.signal
					return await new Promise<never>(() => {})
				},
			})
			const observedDefault = rejectionOf(settleWithin(defaultRequest, 30_100))
			let settled = false
			void defaultRequest.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)

			await vi.advanceTimersByTimeAsync(29_999)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			await vi.advanceTimersByTimeAsync(100)
			const failure = await observedDefault
			expect(failure).toMatchObject({ name: 'TimeoutError' })
			expect(defaultSignal?.reason).toBe(failure)

			let unboundedSignal: AbortSignal | undefined
			const unbounded = fetchAgentCard('https://peer.example', {
				fetch: async (_url, init) => {
					unboundedSignal = init?.signal
					return await new Promise<never>(() => {})
				},
				timeoutMs: 0,
			})
			void unbounded.catch(() => {})
			await vi.advanceTimersByTimeAsync(60_000)
			expect(unboundedSignal?.aborted).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, 2_147_483_648])(
		'refuses malformed discovery timeout %s before network work',
		async (timeoutMs) => {
			let fetches = 0
			await expect(
				fetchAgentCard('https://peer.example', {
					fetch: async () => {
						fetches += 1
						return ok(CARD)
					},
					timeoutMs,
				}),
			).rejects.toThrow(RangeError)
			expect(fetches).toBe(0)
		},
	)
})

describe('a peer this client cannot speak to is refused at construction', () => {
	it('refuses a card with no jsonrpc interface', async () => {
		// Discovering that mid-delegation would waste a run's time on a wiring
		// mistake the card states plainly.
		expect(
			() =>
				new A2ADelegate({
					id: 'analyst',
					card: { ...CARD, supportedInterfaces: [{ url: 'https://p/x', transport: 'grpc' }] },
					fetch: async () => ok({}),
				}),
		).toThrow(/jsonrpc/)
	})

	it('names the absence of every interface', () => {
		try {
			new A2ADelegate({
				id: 'analyst',
				card: { ...CARD, supportedInterfaces: [] },
				fetch: async () => ok({}),
			})
			throw new Error('Expected construction to fail')
		} catch (err) {
			expect(err).toBeInstanceOf(InvalidAgentCardError)
			expect((err as InvalidAgentCardError).details.url).toBe('(no interface)')
		}
	})

	it.each([
		['pollIntervalMs', 0],
		['pollIntervalMs', -1],
		['pollIntervalMs', 1.5],
		['pollIntervalMs', Number.NaN],
		['pollIntervalMs', Number.POSITIVE_INFINITY],
		['pollIntervalMs', 2_147_483_648],
		['timeoutMs', 0],
		['timeoutMs', -1],
		['timeoutMs', 1.5],
		['timeoutMs', Number.NaN],
		['timeoutMs', Number.POSITIVE_INFINITY],
		['timeoutMs', 2_147_483_648],
	] as const)('refuses malformed %s=%s before dispatch', (name, value) => {
		expect(
			() =>
				new A2ADelegate({
					id: 'analyst',
					card: CARD,
					fetch: async () => ok({}),
					[name]: value,
				}),
		).toThrow(RangeError)
	})
})

describe('dispatching to a peer', () => {
	it('sends the prompt and returns a completed answer', async () => {
		const { fetch, calls } = peer([
			task('completed', {
				status: { state: 'completed' },
				artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: 'revenue is up' }] }],
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(calls[0]?.method).toBe('message/send')
		expect(calls[0]?.body.params?.message?.parts[0]?.text).toBe('summarise Q3')
		expect(result).toEqual({ status: 'completed', output: 'revenue is up' })
	})

	it('prefers an artifact over the status sentence', async () => {
		// A peer that produced an artifact put its answer there; the status
		// message is usually a sentence ABOUT the answer.
		const { fetch } = peer([
			task('completed', {
				status: {
					state: 'completed',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'done!' }] },
				},
				artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: 'the real answer' }] }],
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result.output).toBe('the real answer')
	})

	it('polls until the peer reaches a terminal state', async () => {
		const { fetch, calls } = peer([
			task('running', { status: { state: 'running' } }),
			task('running', { status: { state: 'running' } }),
			task('completed', {
				status: {
					state: 'completed',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'ok' }] },
				},
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(calls.map((c) => c.method)).toEqual(['message/send', 'tasks/get', 'tasks/get'])
		expect(result.status).toBe('completed')
	})

	it('uses the configured poll interval rather than a fixed loop cadence', async () => {
		vi.useFakeTimers()
		try {
			const { fetch, calls } = peer([
				task('running', { status: { state: 'running' } }),
				task('completed', { status: { state: 'completed' } }),
			])
			const running = delegate(fetch, { pollIntervalMs: 7, timeoutMs: 100 }).dispatch(request, {})
			const observed = settleWithin(running, 8)
			void observed.catch(() => {})

			await vi.advanceTimersByTimeAsync(6)
			expect(calls.map((call) => call.method)).toEqual(['message/send'])
			await vi.advanceTimersByTimeAsync(2)
			await expect(observed).resolves.toMatchObject({ status: 'completed' })
			expect(calls.map((call) => call.method)).toEqual(['message/send', 'tasks/get'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('reports a peer failure with the peer’s own words', async () => {
		const { fetch } = peer([
			task('failed', {
				status: {
					state: 'failed',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'the sheet was empty' }] },
				},
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result).toMatchObject({ status: 'failed', error: 'the sheet was empty' })
	})

	it('does not invent output for a peer cancellation with no message', async () => {
		const { fetch } = peer([task('canceled', { status: { state: 'canceled' } })])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result).toEqual({ status: 'cancelled' })
	})

	it('keeps the peer’s explanation when a cancellation carries one', async () => {
		const { fetch } = peer([
			task('canceled', {
				status: {
					state: 'canceled',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'superseded' }] },
				},
			}),
		])

		await expect(delegate(fetch).dispatch(request, {})).resolves.toEqual({
			status: 'cancelled',
			output: 'superseded',
		})
	})

	it('does not turn a data-only artifact into text output', async () => {
		const { fetch } = peer([
			task('completed', {
				status: { state: 'completed' },
				artifacts: [{ artifactId: 'data', parts: [{ kind: 'data', data: { rows: 3 } }] }],
			}),
		])

		await expect(delegate(fetch).dispatch(request, {})).resolves.toEqual({ status: 'completed' })
	})

	it('does not read `input-required` as an answer', async () => {
		// The peer did its work and is waiting; calling that `completed` hands
		// the parent a half-answer as though it were the answer.
		const { fetch, calls } = peer([
			task('input-required', {
				status: {
					state: 'input-required',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'which quarter?' }] },
				},
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result.status).toBe('failed')
		expect(result.error).toMatch(/waiting for more input/)
		// The question is still carried: it is what a human reading the
		// failure needs in order to act.
		expect(result.output).toBe('which quarter?')
		expect(calls.map((call) => [call.method, call.body.params?.id])).toEqual([
			['message/send', undefined],
			['tasks/cancel', 'task-1'],
		])
	})

	it('does not invent output when an input-required task carries no question', async () => {
		const { fetch, calls } = peer([task('input-required', { status: { state: 'input-required' } })])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/more input/) })
		expect(result.output).toBeUndefined()
		expect(calls.map((call) => call.method)).toEqual(['message/send', 'tasks/cancel'])
	})

	it('gives up rather than polling forever', async () => {
		const { fetch, calls } = peer([task('running', { status: { state: 'running' } })])

		const result = await delegate(fetch, { timeoutMs: 20 }).dispatch(request, {})

		expect(result.status).toBe('failed')
		expect(result.error).toMatch(/still running/)
		expect(calls.filter((call) => call.method === 'tasks/cancel')).toHaveLength(1)
	})

	it('bounds the initial message request, including its response body', async () => {
		vi.useFakeTimers()
		try {
			let transport: AbortSignal | undefined
			const running = delegate(
				async (_url, init) => {
					transport = init?.signal
					return {
						ok: true,
						status: 200,
						json: async () => await new Promise<never>(() => {}),
						text: async () => '',
					}
				},
				{ timeoutMs: 10 },
			).dispatch(request, {})
			const observed = settleWithin(running, 600)
			void observed.catch(() => {})

			await vi.advanceTimersByTimeAsync(10)
			// `message/send` gets one bounded chance to reveal a task id before
			// its transport is abandoned; without an id A2A cannot address it.
			await vi.advanceTimersByTimeAsync(590)
			const result = await observed

			expect(result).toMatchObject({ status: 'failed' })
			expect(result.error).toMatch(/remote outcome is unknown/)
			expect(transport?.aborted).toBe(true)
			expect(transport?.reason).toMatchObject({ name: 'TimeoutError' })
		} finally {
			vi.useRealTimers()
		}
	})

	it('starts the default deadline before message/send, not after it', async () => {
		vi.useFakeTimers()
		try {
			let transport: AbortSignal | undefined
			const bare = new A2ADelegate({
				id: 'analyst',
				card: CARD,
				fetch: async (_url, init) => {
					transport = init?.signal
					return await new Promise<never>(() => {})
				},
			})
			const running = bare.dispatch(request, {})
			const observed = settleWithin(running, 600_600)
			void observed.catch(() => {})
			let settled = false
			void running.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)

			await vi.advanceTimersByTimeAsync(599_999)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(601)
			await expect(observed).resolves.toMatchObject({ status: 'failed' })
			expect(transport?.reason).toMatchObject({ name: 'TimeoutError' })
		} finally {
			vi.useRealTimers()
		}
	})

	it('refuses a reply that is not an A2A task', async () => {
		// A foreign service's reply becomes a result the model reads as an
		// answer. A malformed task and a task in a state we mishandle are
		// exactly what a parse separates.
		const { fetch, calls } = peer([{ id: 'task-1', status: { state: 'invented' } }])

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(A2ARequestError)
		expect(calls.map((call) => [call.method, call.body.params?.id])).toEqual([
			['message/send', undefined],
			['tasks/cancel', 'task-1'],
		])
	})

	it('cancels a known running task before surfacing a malformed poll reply', async () => {
		const { fetch, calls } = peer([
			task('running', { status: { state: 'running' } }),
			{ id: 'task-1', status: { state: 'invented' } },
			task('canceled', { status: { state: 'canceled' } }),
		])

		const failure = await rejectionOf(settleWithin(delegate(fetch).dispatch(request, {})))

		expect(failure).toBeInstanceOf(A2ARequestError)
		expect(failure).toMatchObject({ details: { method: 'tasks/get' } })
		expect(calls.map((call) => [call.method, call.body.params?.id])).toEqual([
			['message/send', undefined],
			['tasks/get', 'task-1'],
			['tasks/cancel', 'task-1'],
		])
	})

	it('refuses a poll reply for another task and cleans up the requested task', async () => {
		const { fetch, calls } = peer([
			{ id: 'task-A', status: { state: 'running' } },
			{
				id: 'task-B',
				status: { state: 'completed' },
				artifacts: [{ artifactId: 'other-task', parts: [{ kind: 'text', text: 'secret-B' }] }],
			},
			task('canceled', { status: { state: 'canceled' } }),
		])

		const failure = await rejectionOf(settleWithin(delegate(fetch).dispatch(request, {})))

		expect(failure).toBeInstanceOf(A2ARequestError)
		expect(failure).toMatchObject({
			message: 'tasks/get returned task task-B for requested task task-A',
			details: { method: 'tasks/get' },
		})
		expect(calls.map((call) => [call.method, call.body.params?.id])).toEqual([
			['message/send', undefined],
			['tasks/get', 'task-A'],
			['tasks/cancel', 'task-A'],
		])
	})

	it('refuses an empty task id before it can become a poll or cancel address', async () => {
		const { fetch } = peer([{ id: '', status: { state: 'running' } }])

		const failure = await rejectionOf(settleWithin(delegate(fetch).dispatch(request, {})))
		expect(failure).toBeInstanceOf(A2ARequestError)
	})

	it('surfaces a JSON-RPC error as an error, not as a task', async () => {
		const fetch: FetchLike = async () =>
			ok({ jsonrpc: '2.0', id: '1', error: { code: 'TaskNotFound', message: 'no such task' } })

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(/no such task/)
	})

	it('carries the configured headers on every request', async () => {
		const seen: (Record<string, string> | undefined)[] = []
		const fetch: FetchLike = async (_url, init) => {
			seen.push(init?.headers)
			return ok({
				jsonrpc: '2.0',
				id: '1',
				result: task('completed', { status: { state: 'completed' } }),
			})
		}

		await delegate(fetch, { headers: { authorization: 'Bearer shh' } }).dispatch(request, {})

		expect(seen[0]?.authorization).toBe('Bearer shh')
	})
})

describe('cancelling reaches the peer, not just our own loop', () => {
	it('sends tasks/cancel when the delegation is aborted', async () => {
		// Aborting only the poll leaves the peer working, billed, and holding
		// whatever the task holds.
		const controller = new AbortController()
		const { fetch, calls } = peer([task('running', { status: { state: 'running' } })])

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		await new Promise((resolve) => setTimeout(resolve, 5))
		controller.abort()
		const result = await settleWithin(running)
		await new Promise((resolve) => setTimeout(resolve, 5))

		expect(result.status).toBe('cancelled')
		expect(calls.some((c) => c.method === 'tasks/cancel')).toBe(true)
	})

	it('settles a non-cooperative poll with the exact caller cause', async () => {
		const controller = new AbortController()
		const reason = new Error('parent no longer needs the answer')
		let pollSignal: AbortSignal | undefined
		const calls: string[] = []
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as { method?: string }
			calls.push(body.method ?? '')
			if (body.method === 'message/send') {
				return ok({
					jsonrpc: '2.0',
					id: '1',
					result: task('running', { status: { state: 'running' } }),
				})
			}
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
			}
			pollSignal = init?.signal
			return await new Promise<never>(() => {})
		}

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		await vi.waitFor(() => expect(pollSignal).toBeDefined())
		controller.abort(reason)
		const result = await settleWithin(running)

		expect(result.status).toBe('cancelled')
		expect(pollSignal?.aborted).toBe(true)
		expect(pollSignal?.reason).toBe(reason)
		expect(calls.filter((method) => method === 'tasks/cancel')).toHaveLength(1)
	})

	it('does not let transport AbortError erase the caller who stopped the poll', async () => {
		const controller = new AbortController()
		const reason = new Error('operator pressed stop')
		let polling = false
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as { method?: string }
			if (body.method === 'message/send') {
				return ok({
					jsonrpc: '2.0',
					id: '1',
					result: task('running', { status: { state: 'running' } }),
				})
			}
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
			}
			polling = true
			return await new Promise<never>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('transport closed', 'AbortError'))
				})
			})
		}

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		await vi.waitFor(() => expect(polling).toBe(true))
		controller.abort(reason)

		await expect(settleWithin(running)).resolves.toEqual({ status: 'cancelled' })
		expect(controller.signal.reason).toBe(reason)
	})

	it('does not let transport AbortError turn a deadline into cancellation', async () => {
		let pollSignal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as { method?: string }
			if (body.method === 'message/send') {
				return ok({
					jsonrpc: '2.0',
					id: '1',
					result: task('running', { status: { state: 'running' } }),
				})
			}
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
			}
			pollSignal = init?.signal
			return await new Promise<never>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					reject(new DOMException('transport closed', 'AbortError'))
				})
			})
		}

		const result = await settleWithin(delegate(fetch, { timeoutMs: 10 }).dispatch(request, {}))

		expect(result).toMatchObject({ status: 'failed' })
		expect(result.error).toMatch(/still running/)
		expect(pollSignal?.reason).toMatchObject({ name: 'TimeoutError' })
	})

	it('bounds the best-effort peer cancel instead of creating a second hang', async () => {
		vi.useFakeTimers()
		try {
			const controller = new AbortController()
			let pollSignal: AbortSignal | undefined
			let cancelSignal: AbortSignal | undefined
			const fetch: FetchLike = async (_url, init) => {
				const body = JSON.parse(init?.body ?? '{}') as { method?: string }
				if (body.method === 'message/send') {
					return ok({
						jsonrpc: '2.0',
						id: '1',
						result: task('running', { status: { state: 'running' } }),
					})
				}
				if (body.method === 'tasks/cancel') {
					cancelSignal = init?.signal
					return await new Promise<never>(() => {})
				}
				pollSignal = init?.signal
				return await new Promise<never>(() => {})
			}

			const running = delegate(fetch).dispatch(request, { signal: controller.signal })
			const observed = settleWithin(running, 600)
			void observed.catch(() => {})
			await vi.advanceTimersByTimeAsync(1)
			expect(pollSignal).toBeDefined()
			controller.abort(new Error('stop'))
			await vi.advanceTimersByTimeAsync(0)
			expect(cancelSignal).toBeDefined()
			await vi.advanceTimersByTimeAsync(600)

			await expect(observed).resolves.toEqual({ status: 'cancelled' })
			expect(cancelSignal?.aborted).toBe(true)
			expect(cancelSignal?.reason).toMatchObject({ name: 'TimeoutError' })
		} finally {
			vi.useRealTimers()
		}
	})

	it('uses a returned task id to clean up cancellation during message/send', async () => {
		const controller = new AbortController()
		const sent = deferred<ReturnType<typeof ok>>()
		const calls: string[] = []
		let initialSignal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as { method?: string }
			calls.push(body.method ?? '')
			if (body.method === 'message/send') {
				initialSignal = init?.signal
				return await sent.promise
			}
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
			}
			return await new Promise<never>(() => {})
		}

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		controller.abort(new Error('stop during send'))
		expect(initialSignal?.aborted).toBe(false)
		sent.resolve(
			ok({
				jsonrpc: '2.0',
				id: '1',
				result: task('running', { status: { state: 'running' } }),
			}),
		)

		await expect(settleWithin(running)).resolves.toEqual({ status: 'cancelled' })
		expect(initialSignal?.aborted).toBe(true)
		expect(calls).toEqual(['message/send', 'tasks/cancel'])
	})

	it('keeps a safe cleanup id even when the recovered task body is malformed', async () => {
		const controller = new AbortController()
		const sent = deferred<ReturnType<typeof ok>>()
		const calls: { readonly method: string; readonly id?: string }[] = []
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as {
				method?: string
				params?: { id?: string }
			}
			calls.push({ method: body.method ?? '', id: body.params?.id })
			if (body.method === 'message/send') return await sent.promise
			return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
		}

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		controller.abort(new Error('stop during malformed reply'))
		sent.resolve(
			ok({
				jsonrpc: '2.0',
				id: '1',
				result: { id: 'task-safe-to-cancel', status: { state: 'unknown' } },
			}),
		)

		await expect(settleWithin(running)).resolves.toEqual({ status: 'cancelled' })
		expect(calls).toEqual([
			{ method: 'message/send', id: undefined },
			{ method: 'tasks/cancel', id: 'task-safe-to-cancel' },
		])
	})

	it('does not let a peer refusing the cancel become the parent’s exception', async () => {
		// Best-effort courtesy on a path already unwinding. `TaskNotCancelable`
		// is a real A2A answer, and the parent's cancellation is not undone by
		// the peer declining it.
		const controller = new AbortController()
		let sends = 0
		const fetch: FetchLike = async (_url, init) => {
			const body = (init?.body ? JSON.parse(init.body) : {}) as { method?: string }
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', error: { code: 'TaskNotCancelable' } })
			}
			sends += 1
			return ok({
				jsonrpc: '2.0',
				id: '1',
				result: task('running', { status: { state: 'running' } }),
			})
		}

		const running = delegate(fetch).dispatch(request, { signal: controller.signal })
		await new Promise((resolve) => setTimeout(resolve, 5))
		controller.abort()

		await expect(running).resolves.toMatchObject({ status: 'cancelled' })
		expect(sends).toBeGreaterThan(0)
	})
})

describe('the peer reaches the delegation predicates, through the scheduler', () => {
	const create = (agentId: string): CreateTaskOptions => ({
		agentId,
		prompt: 'summarise Q3',
		workingDirectory: '/tmp/x',
	})

	it('a completed peer reads as a succeeded task', async () => {
		// The whole point. Nothing between the delegation tool and this
		// assertion knows the worker was not one of ours.
		const { fetch } = peer([
			task('completed', {
				status: {
					state: 'completed',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'up 12%' }] },
				},
			}),
		])
		const scheduler = new DelegatingTaskScheduler({ delegates: [delegate(fetch)] })

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(create('analyst'))).taskId,
		)

		expect(taskSucceeded(settled)).toBe(true)
		expect(settled.result?.result).toBe('up 12%')
	})

	it('a failed peer reads as a failed task, not an answer', async () => {
		const { fetch } = peer([
			task('failed', {
				status: {
					state: 'failed',
					message: { role: 'agent', parts: [{ kind: 'text', text: 'nope' }] },
				},
			}),
		])
		const scheduler = new DelegatingTaskScheduler({ delegates: [delegate(fetch)] })

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(create('analyst'))).taskId,
		)

		expect(taskSucceeded(settled)).toBe(false)
		expect(taskFailed(settled)).toBe(true)
	})

	it('a peer that cannot be reached at all fails the task rather than hanging', async () => {
		const fetch: FetchLike = async () => {
			throw new Error('ECONNREFUSED')
		}
		const scheduler = new DelegatingTaskScheduler({ delegates: [delegate(fetch)] })

		const settled = await scheduler.waitForTask(
			(await scheduler.createTask(create('analyst'))).taskId,
		)

		expect(taskFailed(settled)).toBe(true)
		expect(settled.result?.lastError).toMatch(/ECONNREFUSED/)
	})

	it('cancelTask settles waitForTask while the peer’s first request is still in flight', async () => {
		const sent = deferred<ReturnType<typeof ok>>()
		const calls: string[] = []
		let initialSignal: AbortSignal | undefined
		const fetch: FetchLike = async (_url, init) => {
			const body = JSON.parse(init?.body ?? '{}') as { method?: string }
			calls.push(body.method ?? '')
			if (body.method === 'message/send') {
				initialSignal = init?.signal
				return await sent.promise
			}
			if (body.method === 'tasks/cancel') {
				return ok({ jsonrpc: '2.0', id: '1', result: task('canceled') })
			}
			return await new Promise<never>(() => {})
		}
		const scheduler = new DelegatingTaskScheduler({ delegates: [delegate(fetch)] })

		const created = await scheduler.createTask(create('analyst'))
		scheduler.cancelTask(created.taskId)
		sent.resolve(
			ok({
				jsonrpc: '2.0',
				id: '1',
				result: task('running', { status: { state: 'running' } }),
			}),
		)
		const safety = new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error('scheduler cancellation did not settle')), 100)
		})
		const settled = await Promise.race([scheduler.waitForTask(created.taskId), safety])

		expect(settled.state).toBe('canceled')
		expect(settled.result?.status).toBe('cancelled')
		expect(initialSignal?.aborted).toBe(true)
		expect(calls).toEqual(['message/send', 'tasks/cancel'])
	})
})

describe('the transport’s own failures are answers, not surprises', () => {
	it('reports an HTTP error on an RPC call, naming the status', async () => {
		// Distinct from the card fetch: a peer whose card reads fine can still
		// answer 503 to `message/send`, and "the peer is down" is a different
		// next move from "the peer refused".
		const fetch: FetchLike = async () => ({
			ok: false,
			status: 503,
			json: async () => ({}),
			text: async () => '',
		})

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(/HTTP 503/)
	})

	it('surfaces a JSON-RPC error that carries no code', async () => {
		// The A2A error object's `code` is optional, and an error with only a
		// message must not be swallowed for lacking one.
		const fetch: FetchLike = async () =>
			ok({ jsonrpc: '2.0', id: '1', error: { message: 'something went wrong' } })

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(/something went wrong/)
	})

	it('names the method when a JSON-RPC error carries neither code nor message', async () => {
		const fetch: FetchLike = async () => ok({ jsonrpc: '2.0', id: '1', error: {} })

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(/message\/send/)
	})

	it('refuses a card whose body is not JSON at all', async () => {
		const fetch: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError('Unexpected token < in JSON')
			},
			text: async () => '<html>',
		})

		await expect(fetchAgentCard('https://peer.example', { fetch })).rejects.toThrow(
			/Unexpected token/,
		)
	})

	it('refuses a card fetch that rejected with a non-Error', async () => {
		// A `fetch` implementation that throws a string is not hypothetical in
		// a polyfilled environment, and the message must still say something.
		const fetch: FetchLike = async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw 'not an error object'
			},
			text: async () => '',
		})

		await expect(fetchAgentCard('https://peer.example', { fetch })).rejects.toThrow(/not usable/)
	})

	it('forwards an abort signal to the card fetch', async () => {
		let seen: AbortSignal | undefined
		await fetchAgentCard('https://peer.example', {
			fetch: async (_url, init) => {
				seen = init?.signal
				return ok(CARD)
			},
			signal: new AbortController().signal,
		})

		expect(seen).toBeDefined()
	})

	it('reports a delegation aborted before it began without creating remote work', async () => {
		const { fetch, calls } = peer([task('running', { status: { state: 'running' } })])

		const result = await delegate(fetch).dispatch(request, { signal: AbortSignal.abort() })

		expect(result.status).toBe('cancelled')
		expect(calls).toEqual([])
	})

	it('uses its own defaults when none are configured', async () => {
		// The `??` fallbacks, exercised rather than assumed: a delegate built
		// with only the required fields must still work.
		const { fetch } = peer([task('completed', { status: { state: 'completed' } })])
		const bare = new A2ADelegate({ id: 'analyst', card: CARD, fetch })

		await expect(bare.dispatch(request, {})).resolves.toMatchObject({ status: 'completed' })
	})

	it('reports a terminal state with no message at all', async () => {
		// `rejected` with an empty status: the fallback sentence is what a
		// reader gets, and it must name the state rather than say nothing.
		const { fetch } = peer([task('rejected', { status: { state: 'rejected' } })])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result).toMatchObject({ status: 'failed' })
		expect(result.error).toMatch(/rejected/)
		expect(result.output).toBeUndefined()
	})

	it('ignores a non-text part when reading the answer', async () => {
		const { fetch } = peer([
			task('completed', {
				status: { state: 'completed' },
				artifacts: [
					{
						artifactId: 'a1',
						parts: [
							{ kind: 'data', data: { rows: 3 } },
							{ kind: 'text', text: 'three rows' },
						],
					},
				],
			}),
		])

		const result = await delegate(fetch).dispatch(request, {})

		expect(result.output).toBe('three rows')
	})
})
