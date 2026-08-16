import { describe, expect, it } from 'vitest'

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
	body: { method?: string; params?: { message: { parts: { text: string }[] } } }
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
		expect(calls[0]?.body.params?.message.parts[0]?.text).toBe('summarise Q3')
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

	it('does not read `input-required` as an answer', async () => {
		// The peer did its work and is waiting; calling that `completed` hands
		// the parent a half-answer as though it were the answer.
		const { fetch } = peer([
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
	})

	it('gives up rather than polling forever', async () => {
		const { fetch } = peer([task('running', { status: { state: 'running' } })])

		const result = await delegate(fetch, { timeoutMs: 20 }).dispatch(request, {})

		expect(result.status).toBe('failed')
		expect(result.error).toMatch(/still running/)
	})

	it('refuses a reply that is not an A2A task', async () => {
		// A foreign service's reply becomes a result the model reads as an
		// answer. A malformed task and a task in a state we mishandle are
		// exactly what a parse separates.
		const { fetch } = peer([{ id: 'task-1', status: { state: 'invented' } }])

		await expect(delegate(fetch).dispatch(request, {})).rejects.toThrow(A2ARequestError)
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
		const result = await running
		await new Promise((resolve) => setTimeout(resolve, 5))

		expect(result.status).toBe('cancelled')
		expect(calls.some((c) => c.method === 'tasks/cancel')).toBe(true)
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
})
