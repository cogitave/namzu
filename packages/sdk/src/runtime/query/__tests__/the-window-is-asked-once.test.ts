import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { TurnCancelled } from '../../../types/session/cancel-cause.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

/**
 * The driver is asked what the window is exactly once per turn.
 *
 * The two consumers are synchronous and in the hot loop — the compaction
 * trigger and the per-iteration usage event. Turning either into an await
 * would put a network round trip on every iteration of every turn, so the
 * answer is resolved at the door and carried.
 *
 * And a driver that cannot answer must not cost anything. The table is
 * still there; a listing endpoint that is down for a minute is not a reason
 * for a turn to fail.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** A provider that counts how often the runtime asks about its window. */
class ReportingProvider extends MockLLMProvider {
	calls = 0
	readonly resolverSignals: AbortSignal[] = []
	constructor(
		private readonly answer: () => Promise<number | undefined>,
		turns: number,
	) {
		super({
			turns: [
				...Array.from({ length: turns }, (_, i) => ({
					toolCalls: [{ id: `t${i}`, name: 'noop', args: {} }],
					finishReason: 'tool_calls' as const,
				})),
				{ text: 'done' },
			] as never,
		})
	}
	async resolveContextWindow(_model: string, signal?: AbortSignal): Promise<number | undefined> {
		this.calls++
		if (signal) this.resolverSignals.push(signal)
		return this.answer()
	}
}

function registry(): ToolRegistry {
	const r = new ToolRegistry()
	return r
}

async function run(
	provider: MockLLMProvider,
	iterations = 4,
	signal?: AbortSignal,
	timeoutMs = 20_000,
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-window-'))
	dirs.push(workingDirectory)
	const events: SessionEvent[] = []

	const result = await drainQuery(
		{
			provider,
			tools: registry(),
			turnConfig: {
				model: 'mock-model',
				timeoutMs,
				tokenBudget: 200_000,
				maxIterations: iterations,
			},
			compactionConfig: {
				...CompactionConfigSchema.parse({}),
				// Small enough that the trigger fires, so the consumer that
				// reads the window actually runs.
				contextWindowTokens: undefined,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('go '.repeat(500))],
			workingDirectory,
			sessionId: '16328078-128b-494d-b447-e96255b3bdae' as SessionId,
			topicId: '763896b1-e13a-4282-8192-726852dded26' as TopicId,
			projectId: '0ee59c1c-c0aa-4560-bacb-c36fbfbbee2f' as ProjectId,
			tenantId: 'bc5e378a-03cb-4f5b-af29-e1d5409863d6' as TenantId,
			...(signal ? { signal } : {}),
		},
		(event: SessionEvent) => {
			events.push(event)
		},
	)

	return { result, events }
}

describe('the context window is asked for once per turn', () => {
	it('calls the driver exactly once however many iterations run', async () => {
		// Moving the call into the per-iteration path is the mistake this
		// exists to stop, and it would be invisible without a counter: the
		// answer would be identical every time.
		const provider = new ReportingProvider(async () => 1_000_000, 3)

		await run(provider)

		expect(provider.calls).toBe(1)
	})

	it('reports the source as `provider` on the surface a host reads', async () => {
		// Not just the trigger. A host reading `token_usage_updated` has to
		// be able to see WHERE the window came from, or a wrong number is
		// indistinguishable from a right one.
		const provider = new ReportingProvider(async () => 1_000_000, 2)

		const { events } = await run(provider)

		const usage = events.filter(
			(e): e is Extract<SessionEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.length).toBeGreaterThan(0)
		expect(usage.some((e) => e.windowSource === 'provider')).toBe(true)
		expect(usage.some((e) => e.contextWindowTokens === 1_000_000)).toBe(true)
	})

	it('completes on the table when the driver rejects', async () => {
		// A turn that would have worked must not fail because a listing
		// endpoint was down. The window is an optimisation over a working
		// default, not a prerequisite.
		const provider = new ReportingProvider(async () => {
			throw new Error('models endpoint is down')
		}, 2)

		const { result, events } = await run(provider)

		expect(result.status).toBe('completed')
		const usage = events.filter(
			(e): e is Extract<SessionEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.every((e) => e.windowSource !== 'provider')).toBe(true)
	})

	it('completes on the table when the driver answers `undefined`', async () => {
		const provider = new ReportingProvider(async () => undefined, 2)

		const { result, events } = await run(provider)

		expect(result.status).toBe('completed')
		expect(provider.calls).toBe(1)
		const usage = events.filter(
			(e): e is Extract<SessionEvent, { type: 'token_usage_updated' }> =>
				e.type === 'token_usage_updated',
		)
		expect(usage.every((e) => e.windowSource !== 'provider')).toBe(true)
	})

	it('settles cancellation even when the optional resolver ignores its signal', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (value: number | undefined) => void
		const held = new Promise<number | undefined>((resolve) => {
			release = resolve
		})
		const provider = new ReportingProvider(() => {
			markStarted()
			return held
		}, 1)
		const caller = new AbortController()
		const running = run(provider, 2, caller.signal)
		let settled = false
		void running.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await started
		caller.abort(new TurnCancelled('user'))

		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 10 })
		} catch (err) {
			waitFailure = err
		} finally {
			// A broken implementation must fail an assertion, not leave Vitest
			// waiting on the deliberately non-cooperative resolver.
			release(undefined)
		}

		const { result, events } = await running
		if (waitFailure) throw waitFailure
		expect(result.status).toBe('cancelled')
		expect(provider.requests).toHaveLength(0)
		expect([...events].reverse().find((event) => event.type === 'turn_completed')).toMatchObject({
			type: 'turn_completed',
			stopReason: 'cancelled',
			cancelCause: 'user',
		})
	})

	it('falls back and runs when metadata stays pending without caller cancellation', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (value: number | undefined) => void
		const held = new Promise<number | undefined>((resolve) => {
			release = resolve
		})
		const provider = new ReportingProvider(() => {
			markStarted()
			return held
		}, 0)

		// The clock is fake for exactly this case, and it is advanced exactly
		// once. No real timer appears anywhere below, in the assertions or in
		// the waiting: the deadline under this clock is the only thing that
		// can settle the turn, so a step of the clock is a deterministic probe
		// rather than a guess about how fast the machine is.
		vi.useFakeTimers()
		try {
			const running = run(provider, 1, undefined, 20)

			await started

			// `timeoutMs` is BOTH the turn's budget and the resolver's deadline
			// — `resolveProviderContextWindow` is handed `turnConfig.timeoutMs`
			// — and on a real clock the two raced: the turn's seam checks could
			// see a 20 ms budget already spent by the very wait the deadline
			// exists to end, so this case measured the machine and failed in
			// both directions (no request at all, or a second one after the
			// stream was cut). Under a fake clock the deadline is the only
			// thing that elapses here, and it elapses exactly once.
			//
			// The guard is built AFTER the fallback — `query()` awaits
			// `resolveProviderContextWindow` before `new GuardCoordinator`, both
			// in the same function — so the turn's own budget starts at this
			// post-fallback instant and keeps reading zero for the rest of the
			// case. Nothing below can time the turn out, in either direction,
			// and nothing below consults a wall clock. Named rather than cited
			// by line: a number here drifted once already.
			await vi.advanceTimersByTimeAsync(20)

			// Read BEFORE anything waits on the turn. This is what a mutation
			// that drops the private deadline cannot produce, so it fails HERE,
			// by name, instead of leaving Vitest waiting on a resolver that
			// never answers.
			try {
				expect(provider.resolverSignals).toHaveLength(1)
				expect(provider.resolverSignals[0]?.aborted).toBe(true)
				expect(provider.resolverSignals[0]?.reason).toMatchObject({
					message: 'Provider context-window lookup exceeded 20ms',
				})
			} finally {
				// Whether that passed or failed, the resolver is released: the
				// run above is still holding it, and a failing case must not
				// leave a promise nobody settles behind it.
				release(undefined)
			}

			const { result, events } = await running
			expect(result.status).toBe('completed')
			expect(provider.requests).toHaveLength(1)
			const usage = events.filter(
				(event): event is Extract<SessionEvent, { type: 'token_usage_updated' }> =>
					event.type === 'token_usage_updated',
			)
			expect(usage.every((event) => event.windowSource !== 'provider')).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it('does not enter the optional resolver after authority was already withdrawn', async () => {
		const provider = new ReportingProvider(async () => 1_000_000, 1)
		const caller = new AbortController()
		caller.abort(new TurnCancelled('user'))

		const { result, events } = await run(provider, 2, caller.signal)

		expect(result.status).toBe('cancelled')
		expect(provider.calls).toBe(0)
		expect(provider.resolverSignals).toHaveLength(0)
		expect(provider.requests).toHaveLength(0)
		expect([...events].reverse().find((event) => event.type === 'turn_completed')).toMatchObject({
			type: 'turn_completed',
			stopReason: 'cancelled',
			cancelCause: 'user',
		})
	})

	it('does not ask a driver that has no such member', async () => {
		// The absent case, which is every driver in the tree but one. It has
		// to be exactly as it was — a missing member is not an error and not
		// a reason to log anything.
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		const { result } = await run(provider, 2)

		expect(result.status).toBe('completed')
	})
})
