import { describe, expect, it } from 'vitest'

import { runCompactionCheck } from '../runtime/query/iteration/phases/compaction.js'
import type { IterationContext } from '../runtime/query/iteration/phases/context.js'
import '../store/session-claim.js'
import { InMemorySessionLog } from '../store/session-log/index.js'
import type { Message } from '../types/message/index.js'
import type { SessionEvent } from '../types/session/index.js'
import { NOOP_LOGGER } from '../utils/log/create-logger.js'
import {
	InvariantNameCollisionError,
	ModuleInvariantError,
	createInvariantRegistry,
	invariants,
} from './index.js'

/**
 * Importing `runCompactionCheck` and `store/session-claim.ts` above is not
 * only for the calls further down — it is what runs `compaction.ts`'s and
 * `session-claim.ts`'s top-level `invariants.register(...)` before any
 * `it()` below reads the shared registry.
 */

describe('InvariantRegistry — collision', () => {
	it('throws InvariantNameCollisionError on a second registration under the same id, naming both fields', () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'thing', () => ({ state: 'holds' }))

		let caught: unknown
		try {
			reg.register('mod', 'thing', () => ({ state: 'violated', detail: 'should never run' }))
		} catch (err) {
			caught = err
		}

		expect(caught).toBeInstanceOf(InvariantNameCollisionError)
		const error = caught as InstanceType<typeof InvariantNameCollisionError>
		expect(error.moduleName).toBe('mod')
		expect(error.invariantName).toBe('thing')
	})

	it('does not overwrite the first registration — proves the guard runs before ManagedRegistry.register', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'thing', () => ({ state: 'holds' }))

		expect(() =>
			reg.register('mod', 'thing', () => ({ state: 'violated', detail: 'a second writer' })),
		).toThrow(InvariantNameCollisionError)

		// ManagedRegistry.register(id, item) — what the throw above guards
		// against reaching — warns and OVERWRITES a duplicate id by default.
		// If that path had been reached instead, this would now report
		// `violated`.
		const outcome = await reg.evaluate('mod:thing', undefined)
		expect(outcome).toEqual({ state: 'holds' })
	})
})

describe('InvariantRegistry — evaluate', () => {
	it('returns the check outcome untouched, including unknown', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'cannot-answer', () => ({ state: 'unknown', reason: 'no data yet' }))

		const outcome = await reg.evaluate('mod:cannot-answer', undefined)
		expect(outcome).toEqual({ state: 'unknown', reason: 'no data yet' })
	})

	it('counts a violated outcome once per call, and does not count holds or unknown', async () => {
		const reg = createInvariantRegistry()
		let verdict: 'holds' | 'violated' | 'unknown' = 'holds'
		reg.register('mod', 'switchable', () => {
			if (verdict === 'holds') return { state: 'holds' }
			if (verdict === 'violated') return { state: 'violated', detail: 'flipped' }
			return { state: 'unknown', reason: 'flipped' }
		})

		await reg.evaluate('mod:switchable', undefined)
		expect(reg.violationCount('mod:switchable')).toBe(0)

		verdict = 'unknown'
		await reg.evaluate('mod:switchable', undefined)
		expect(reg.violationCount('mod:switchable')).toBe(0)

		verdict = 'violated'
		await reg.evaluate('mod:switchable', undefined)
		expect(reg.violationCount('mod:switchable')).toBe(1)

		await reg.evaluate('mod:switchable', undefined)
		expect(reg.violationCount('mod:switchable')).toBe(2)
	})
})

describe('InvariantRegistry — assert', () => {
	it('throws ModuleInvariantError with moduleName/invariantName populated and the message prefixed with the module name', async () => {
		const reg = createInvariantRegistry()
		reg.register('store.run', 'single-open-writer', () => ({
			state: 'violated',
			detail: 'a stale writer',
		}))

		let caught: unknown
		try {
			await reg.assert('store.run:single-open-writer', undefined)
		} catch (err) {
			caught = err
		}

		expect(caught).toBeInstanceOf(ModuleInvariantError)
		const error = caught as InstanceType<typeof ModuleInvariantError>
		expect(error.moduleName).toBe('store.run')
		expect(error.invariantName).toBe('single-open-writer')
		expect(error.message.startsWith('store.run:')).toBe(true)
	})

	it('does not throw on unknown', async () => {
		const reg = createInvariantRegistry()
		reg.register('mod', 'pending', () => ({ state: 'unknown', reason: 'no data yet' }))

		await expect(reg.assert('mod:pending', undefined)).resolves.toBeUndefined()
	})
})

describe('the shared registry, as compaction.ts and session-claim.ts leave it', () => {
	it('lists exactly the two production invariants', () => {
		// Non-empty because importing `runCompactionCheck` and the session-claim
		// bindings above already ran both modules' top-level
		// `invariants.register(...)` calls. An empty set here is the
		// declared-but-undriven failure this task exists to close.
		expect(new Set(invariants.listIds())).toEqual(
			new Set(['compaction:no-split-tool-pair', 'session-log:single-open-writer']),
		)
	})
})

describe('compaction:no-split-tool-pair — wired at its real call site', () => {
	const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })

	it('increments the invariant counter by exactly 1 when a reducer splits a tool pair', async () => {
		const messages: Message[] = Array.from({ length: 12 }, (_, i) =>
			user(`m${i} ${'x'.repeat(400)}`),
		)
		const events: SessionEvent[] = []
		const ctx = {
			recorder: { id: 'ab94d3c0-4f08-417b-b411-66f6b869f37e', messages, currentIteration: 1 },
			turnConfig: { model: 'mock-model' },
			compactionConfig: {
				strategy: 'custom',
				triggerThreshold: 0.1,
				contextWindowTokens: 100,
				keepRecentMessages: 2,
			},
			contextReducer: () => [
				{
					role: 'assistant',
					content: null,
					timestamp: 1,
					toolCalls: [
						{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
					],
				} as Message,
			],
			log: NOOP_LOGGER,
			emitEvent: async (event: SessionEvent) => {
				events.push(event)
			},
		} as unknown as IterationContext

		const before = invariants.violationCount('compaction:no-split-tool-pair')

		await runCompactionCheck(ctx)

		expect(
			events.some((e) => e.type === 'compaction_failed' && e.cause === 'split_tool_pair'),
		).toBe(true)
		expect(
			invariants.violationCount('compaction:no-split-tool-pair') - before,
			'exactly one violation for one split-pair decline',
		).toBe(1)
	})
})

describe('session-log:single-open-writer — wired against the session lease', () => {
	it('reports unknown when handed no session, the namzu doctor call shape', async () => {
		const outcome = await invariants.evaluate('session-log:single-open-writer', undefined)
		expect(outcome.state).toBe('unknown')
	})

	it('holds when the presented fence matches the current lease, and violates — naming the holder — when it is stale', async () => {
		const log = new InMemorySessionLog({
			sessionId: '0197a3f0-0000-7000-8000-000000000001' as never,
		})
		const lease = await log.claim({ holder: 'worker-a', ttlMs: 60_000 })
		expect(lease).not.toBeNull()
		const fence = lease?.fence ?? 0

		const holds = await invariants.evaluate('session-log:single-open-writer', {
			log,
			presentedFence: fence,
		})
		expect(holds).toEqual({ state: 'holds' })

		const before = invariants.violationCount('session-log:single-open-writer')
		const stale = await invariants.evaluate('session-log:single-open-writer', {
			log,
			presentedFence: fence - 1,
		})

		expect(stale.state).toBe('violated')
		expect(
			invariants.violationCount('session-log:single-open-writer') - before,
			'the stale presentation counts as exactly one violation',
		).toBe(1)
		if (stale.state === 'violated') {
			expect(stale.detail).toContain('worker-a')
		}
	})
})
