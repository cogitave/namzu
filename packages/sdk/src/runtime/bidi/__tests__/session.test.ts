import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type {
	BidiEvent,
	BidiProvider,
	BidiRunEvent,
	BidiSession,
} from '../../../types/bidi/index.js'
import { createMockBidiProvider } from '../mock.js'
import { BidiSessionCloseTimeoutError, startBidiRun } from '../session.js'

/**
 * Every other seam in this kernel is turn-based by construction: a run
 * has iterations, an iteration sends a complete message list and reads a
 * stream back, and a checkpoint is taken between two of them. A duplex
 * session has none of those boundaries — input keeps arriving while
 * output is still being produced — so the two properties that matter
 * here do not exist in the turn-based path at all: a tool must not stall
 * the stream, and an interruption must invalidate work in flight.
 */

function slowTool(name: string, gate: Promise<void>, onSignal?: (signal: AbortSignal) => void) {
	return defineTool({
		name,
		description: `${name} tool`,
		inputSchema: z.object({}),
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async (_input, context) => {
			onSignal?.(context.abortSignal)
			await gate
			return { success: true, output: `${name} finished` }
		},
	})
}

function deferred<T>() {
	let resolve: ((value: T | PromiseLike<T>) => void) | undefined
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return {
		promise,
		resolve: (value: T | PromiseLike<T>) => resolve?.(value),
	}
}

function emptyTools(): ToolRegistry {
	return new ToolRegistry()
}

function lateSession(close: () => Promise<void>): BidiSession {
	return {
		send: async () => undefined,
		sendToolResult: async () => undefined,
		events: async function* () {
			await new Promise<void>(() => undefined)
		},
		close,
	}
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise
		return undefined
	} catch (error) {
		return error
	}
}

function open(gate?: Promise<void>) {
	const tools = new ToolRegistry()
	tools.register(slowTool('lookup', gate ?? Promise.resolve()))
	const provider = createMockBidiProvider()
	return { tools, provider }
}

const collectEvents = async (run: { events(): AsyncIterable<BidiRunEvent> }, until: number) => {
	const seen: BidiRunEvent[] = []
	for await (const event of run.events()) {
		seen.push(event)
		if (seen.length >= until) break
	}
	return seen
}

describe('a session with no turn boundary', () => {
	it('refuses a pre-aborted run before asking the provider to connect', async () => {
		const controller = new AbortController()
		const reason = new Error('the caller already left')
		controller.abort(reason)
		let connectCalls = 0
		const provider: BidiProvider = {
			id: 'pre-abort',
			connect: async () => {
				connectCalls++
				return lateSession(async () => undefined)
			},
		}

		const outcome = await caught(
			startBidiRun({
				provider,
				tools: emptyTools(),
				connect: { model: 'mock' },
				workingDirectory: process.cwd(),
				signal: controller.signal,
			}),
		)

		expect(outcome).toBe(reason)
		expect(connectCalls).toBe(0)
	})

	it.each([-1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648])(
		'refuses invalid provider-close bound %s before connecting',
		async (closeTimeoutMs) => {
			let connectCalls = 0
			const provider: BidiProvider = {
				id: 'invalid-close-bound',
				connect: async () => {
					connectCalls++
					return lateSession(async () => undefined)
				},
			}

			await expect(
				startBidiRun({
					provider,
					tools: emptyTools(),
					connect: { model: 'mock' },
					workingDirectory: process.cwd(),
					closeTimeoutMs,
				}),
			).rejects.toThrow(/closeTimeoutMs/)
			expect(connectCalls).toBe(0)
		},
	)

	it('rejects an ignored pending connect with the exact caller reason and closes its late session once', async () => {
		const connection = deferred<BidiSession>()
		let closeCalls = 0
		const provider: BidiProvider = {
			id: 'late-connect',
			connect: async () => await connection.promise,
		}
		const controller = new AbortController()
		const reason = new Error('stop during connect')
		const starting = startBidiRun({
			provider,
			tools: emptyTools(),
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
			signal: controller.signal,
		})

		controller.abort(reason)
		expect(await caught(starting)).toBe(reason)

		connection.resolve(
			lateSession(async () => {
				closeCalls++
				if (closeCalls > 1) throw new Error('late session closed twice')
			}),
		)
		await vi.waitFor(() => expect(closeCalls).toBe(1))
	})

	it('carries the model text through', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'text', text: 'hello there' })
		const seen = await collectEvents(run, 1)

		expect(seen[0]).toMatchObject({ type: 'text', text: 'hello there' })
		await run.close()
	})

	it('answers a tool call on the same session', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)

		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'tool_completed'])
		expect(provider.session()?.sent).toContainEqual({
			toolResult: 't1',
			output: 'lookup finished',
			isError: false,
		})
		await run.close()
	})

	it('keeps delivering model output while a tool is still running', async () => {
		// The property the turn-based loop never needs: awaiting a tool
		// inline would stall the very stream an interruption arrives on.
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const { tools, provider } = open(gate)
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		provider.session()?.push({ type: 'text', text: 'still talking' })

		const seen = await collectEvents(run, 2)
		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'text'])

		release?.()
		await run.close()
	})

	it('abandons a tool answer when the human speaks over the model', async () => {
		// Delivering it would put a stale answer into a conversation that
		// has moved on.
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let toolSignal: AbortSignal | undefined
		const tools = new ToolRegistry()
		tools.register(
			slowTool('lookup', gate, (signal) => {
				toolSignal = signal
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		provider.session()?.push({ type: 'interrupted' })
		await vi.waitFor(() => expect(toolSignal).toBeDefined())
		expect(toolSignal?.aborted).toBe(false)
		release?.()

		const seen = await collectEvents(run, 3)
		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'interrupted', 'tool_abandoned'])
		// Nothing was sent back for it.
		expect(provider.session()?.sent).toEqual([])
		await run.close()
	})

	it('treats a tool result send already in progress as committed across a later interruption', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		const sendStarted = deferred<void>()
		const releaseSend = deferred<void>()
		const originalSend = session.sendToolResult
		session.sendToolResult = async (...args) => {
			sendStarted.resolve()
			await releaseSend.promise
			await originalSend(...args)
		}

		session.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		await sendStarted.promise
		session.push({ type: 'interrupted' })
		releaseSend.resolve()

		const seen = await collectEvents(run, 3)
		expect(seen.map((event) => event.type)).toEqual([
			'tool_started',
			'interrupted',
			'tool_completed',
		])
		expect(session.sent).toContainEqual({
			toolResult: 't1',
			output: 'lookup finished',
			isError: false,
		})
		await run.close()
	})

	it('manual close revokes a held tool without waiting for code that ignores the signal', async () => {
		const never = new Promise<void>(() => undefined)
		let toolSignal: AbortSignal | undefined
		const tools = new ToolRegistry()
		tools.register(
			slowTool('lookup', never, (signal) => {
				toolSignal = signal
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		let closeCalls = 0
		const originalClose = session.close
		session.close = async () => {
			closeCalls++
			if (closeCalls > 1) throw new Error('session closed twice')
			await originalClose()
		}

		session.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		await vi.waitFor(() => expect(toolSignal).toBeDefined())
		await run.close()

		expect(toolSignal?.aborted).toBe(true)
		expect(closeCalls).toBe(1)
		expect(session.sent).toEqual([])
		await run.close()
		expect(closeCalls).toBe(1)
	})

	it('caller cancellation closes once, aborts the tool context, and publishes no late terminal event', async () => {
		let toolSignal: AbortSignal | undefined
		const toolFinished = deferred<void>()
		const tools = new ToolRegistry()
		tools.register(
			slowTool('lookup', toolFinished.promise, (signal) => {
				toolSignal = signal
			}),
		)
		const provider = createMockBidiProvider()
		const controller = new AbortController()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
			signal: controller.signal,
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		let closeCalls = 0
		const originalClose = session.close
		session.close = async () => {
			closeCalls++
			if (closeCalls > 1) throw new Error('session closed twice')
			await originalClose()
		}
		session.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const started = await collectEvents(run, 1)
		expect(started[0]?.type).toBe('tool_started')

		controller.abort(new Error('caller stopped'))
		await vi.waitFor(() => expect(toolSignal?.aborted).toBe(true))
		toolFinished.resolve()
		await run.close()
		await new Promise((resolve) => setImmediate(resolve))

		expect(closeCalls).toBe(1)
		expect(session.sent).toEqual([])
		const afterClose: BidiRunEvent[] = []
		for await (const event of run.events()) afterClose.push(event)
		expect(afterClose).toEqual([])
	})

	it('refuses new input with the exact caller reason after cancellation', async () => {
		const { tools, provider } = open()
		const controller = new AbortController()
		const reason = new Error('the caller owns this stop')
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
			signal: controller.signal,
		})

		controller.abort(reason)

		expect(await caught(run.send({ type: 'text', text: 'too late' }))).toBe(reason)
		await run.close()
		expect(provider.session()?.sent).toEqual([])
	})

	it('ends locally and reports unconfirmed provider cleanup instead of waiting forever', async () => {
		const closeStarted = deferred<void>()
		const session: BidiSession = {
			send: async () => undefined,
			sendToolResult: async () => undefined,
			events: async function* () {
				await new Promise<void>(() => undefined)
			},
			close: async () => {
				closeStarted.resolve()
				await new Promise<void>(() => undefined)
			},
		}
		const provider: BidiProvider = { id: 'held-close', connect: async () => session }
		const run = await startBidiRun({
			provider,
			tools: emptyTools(),
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
			closeTimeoutMs: 10,
		})

		const closing = run.close()
		await closeStarted.promise
		await expect(closing).rejects.toBeInstanceOf(BidiSessionCloseTimeoutError)
		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)
		expect(seen).toEqual([])
	})

	it('defaults the provider-close bound to exactly five seconds', async () => {
		vi.useFakeTimers()
		try {
			const session = lateSession(async () => await new Promise<void>(() => undefined))
			const provider: BidiProvider = { id: 'default-close-bound', connect: async () => session }
			const run = await startBidiRun({
				provider,
				tools: emptyTools(),
				connect: { model: 'mock' },
				workingDirectory: process.cwd(),
			})
			const pending = Symbol('pending')
			let outcome: unknown = pending
			void run.close().then(
				() => {
					outcome = undefined
				},
				(error: unknown) => {
					outcome = error
				},
			)

			await vi.advanceTimersByTimeAsync(4_999)
			expect(outcome).toBe(pending)
			await vi.advanceTimersByTimeAsync(1)
			expect(outcome).toBeInstanceOf(BidiSessionCloseTimeoutError)
			expect(outcome).toMatchObject({ timeoutMs: 5_000 })
		} finally {
			vi.useRealTimers()
		}
	})

	it('keeps a zero provider-close bound unbounded until cleanup settles', async () => {
		vi.useFakeTimers()
		try {
			const releaseClose = deferred<void>()
			const session = lateSession(async () => await releaseClose.promise)
			const provider: BidiProvider = { id: 'unbounded-close', connect: async () => session }
			const run = await startBidiRun({
				provider,
				tools: emptyTools(),
				connect: { model: 'mock' },
				workingDirectory: process.cwd(),
				closeTimeoutMs: 0,
			})
			const pending = Symbol('pending')
			let outcome: unknown = pending
			const closing = run.close().then(
				() => {
					outcome = undefined
				},
				(error: unknown) => {
					outcome = error
				},
			)

			await vi.advanceTimersByTimeAsync(86_400_000)
			expect(outcome).toBe(pending)
			releaseClose.resolve()
			await closing
			expect(outcome).toBeUndefined()
		} finally {
			vi.useRealTimers()
		}
	})

	it('far-side close revokes a held tool context without redundantly closing the provider', async () => {
		const never = new Promise<void>(() => undefined)
		let toolSignal: AbortSignal | undefined
		const tools = new ToolRegistry()
		tools.register(
			slowTool('lookup', never, (signal) => {
				toolSignal = signal
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		let closeCalls = 0
		const originalClose = session.close
		session.close = async () => {
			closeCalls++
			await originalClose()
		}
		session.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const started = await collectEvents(run, 1)
		expect(started[0]?.type).toBe('tool_started')

		session.push({ type: 'closed', reason: 'peer left' })
		const rest: BidiRunEvent[] = []
		for await (const event of run.events()) rest.push(event)

		expect(rest).toEqual([{ type: 'closed', runId: run.runId, reason: 'peer left' }])
		expect(toolSignal?.aborted).toBe(true)
		expect(closeCalls).toBe(0)
	})

	it('coalesces caller and repeated manual close around one non-idempotent provider close', async () => {
		const { tools, provider } = open()
		const controller = new AbortController()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
			signal: controller.signal,
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		const releaseClose = deferred<void>()
		let closeCalls = 0
		const originalClose = session.close
		session.close = async () => {
			closeCalls++
			if (closeCalls > 1) throw new Error('provider close is not idempotent')
			await releaseClose.promise
			await originalClose()
		}

		controller.abort(new Error('caller stopped'))
		const first = run.close()
		const second = run.close()
		releaseClose.resolve()
		await Promise.all([first, second])

		expect(closeCalls).toBe(1)
	})

	it('does not admit a tool event delivered by a driver after local close began', async () => {
		let executeCalls = 0
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'lookup',
				description: 'lookup',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					executeCalls++
					return { success: true, output: 'ran' }
				},
			}),
		)
		const delivered = deferred<IteratorResult<BidiEvent>>()
		const iterator: AsyncIterableIterator<BidiEvent> = {
			next: async () => await delivered.promise,
			[Symbol.asyncIterator]() {
				return this
			},
		}
		const session: BidiSession = {
			send: async () => undefined,
			sendToolResult: async () => undefined,
			events: () => iterator,
			close: async () => {
				delivered.resolve({
					done: false,
					value: { type: 'tool_call', id: 'late', name: 'lookup', arguments: '{}' },
				})
			},
		}
		const provider: BidiProvider = { id: 'late-event', connect: async () => session }
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		await run.close()
		await new Promise((resolve) => setImmediate(resolve))

		expect(executeCalls).toBe(0)
		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)
		expect(seen).toEqual([])
	})

	it('fences the session instead of executing one tool-call id twice', async () => {
		let executeCalls = 0
		const gate = deferred<void>()
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'lookup',
				description: 'lookup',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => {
					executeCalls++
					await gate.promise
					return { success: true, output: 'ran' }
				},
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})
		const session = provider.session()
		if (!session) throw new Error('mock session missing')
		let closeCalls = 0
		const originalClose = session.close
		session.close = async () => {
			closeCalls++
			await originalClose()
		}

		session.push({ type: 'tool_call', id: 'same', name: 'lookup', arguments: '{}' })
		const started = await collectEvents(run, 1)
		await vi.waitFor(() => expect(executeCalls).toBe(1))
		session.push({ type: 'tool_call', id: 'same', name: 'lookup', arguments: '{}' })
		const refused = await collectEvents(run, 1)
		gate.resolve()

		expect(started[0]?.type).toBe('tool_started')
		expect(refused[0]).toMatchObject({ type: 'error', message: expect.stringContaining('same') })
		expect(executeCalls).toBe(1)
		await vi.waitFor(() => expect(closeCalls).toBe(1))
		await run.close()
		expect(closeCalls).toBe(1)
	})

	it('answers a tool that finished before the interruption', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)
		provider.session()?.push({ type: 'interrupted' })

		expect(seen.map((e) => e.type)).toEqual(['tool_started', 'tool_completed'])
		expect(provider.session()?.sent).toHaveLength(1)
		await run.close()
	})

	it('reports a tool failure rather than dropping it', async () => {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'lookup',
				description: 'lookup',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({ success: false, output: '', error: 'the lookup failed' }),
			}),
		)
		const provider = createMockBidiProvider()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'tool_call', id: 't1', name: 'lookup', arguments: '{}' })
		const seen = await collectEvents(run, 2)

		expect(seen[1]).toMatchObject({ type: 'tool_completed', isError: true })
		expect(provider.session()?.sent).toContainEqual({
			toolResult: 't1',
			output: 'the lookup failed',
			isError: true,
		})
		await run.close()
	})

	it('stops reading a driver that keeps talking after it hung up', async () => {
		// A driver that says it closed and then carries on is misbehaving,
		// and a loop that kept forwarding would hand a consumer output from
		// a session it was told had ended.
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'closed' })
		provider.session()?.push({ type: 'text', text: 'still here' })

		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)

		expect(seen.map((e) => e.type)).toEqual(['closed'])
	})

	it('ends the event stream when the far side closes', async () => {
		const { tools, provider } = open()
		const run = await startBidiRun({
			provider,
			tools,
			connect: { model: 'mock' },
			workingDirectory: process.cwd(),
		})

		provider.session()?.push({ type: 'closed', reason: 'the far side hung up' })

		const seen: BidiRunEvent[] = []
		for await (const event of run.events()) seen.push(event)

		expect(seen).toEqual([{ type: 'closed', runId: run.runId, reason: 'the far side hung up' }])
	})
})
