import { describe, expect, it } from 'vitest'

import type { ContextReduction } from '../../../../../compaction/reducer.js'
import type { Message } from '../../../../../types/message/index.js'
import type { RunEvent } from '../../../../../types/run/index.js'
import { NOOP_LOGGER } from '../../../../../utils/log/create-logger.js'
import { runCompactionCheck } from '../compaction.js'
import type { IterationContext } from '../context.js'

/**
 * A shed that did not happen is exactly as consequential as one that did, and
 * only one of them was on the wire.
 *
 * All three decline paths reached a log line and stopped there. Every
 * command-line entry point silences the logger, so the outcome was invisible to
 * the user, to the host AND to the model at once — and the run carried on at
 * full context toward a provider rejection several turns later that named none
 * of this.
 *
 * Each path is driven separately rather than one being tested and the rest
 * assumed. "The other branches presumably do the same" is the reasoning that
 * put the gap here.
 */

const user = (content: string): Message => ({ role: 'user', content, timestamp: 1 })

function context(reducer: IterationContext['contextReducer']): {
	ctx: IterationContext
	events: RunEvent[]
	messages: Message[]
} {
	const events: RunEvent[] = []
	// Enough messages that the trigger fires against the tiny window below.
	const messages: Message[] = Array.from({ length: 12 }, (_, i) => user(`m${i} ${'x'.repeat(400)}`))

	const ctx = {
		runMgr: { id: 'run_dec', messages, currentIteration: 3 },
		runConfig: { model: 'mock-model' },
		compactionConfig: {
			strategy: 'custom',
			triggerThreshold: 0.1,
			contextWindowTokens: 100,
			keepRecentMessages: 2,
		},
		contextReducer: reducer,
		log: NOOP_LOGGER,
		emitEvent: async (event: RunEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext

	return { ctx, events, messages }
}

const failure = (
	events: RunEvent[],
): Extract<RunEvent, { type: 'compaction_failed' }> | undefined =>
	events.find((e): e is Extract<RunEvent, { type: 'compaction_failed' }> => {
		return e.type === 'compaction_failed'
	})

describe('a compaction that sheds nothing says so', () => {
	it('reports a reducer that threw, and carries its message', async () => {
		const { ctx, events, messages } = context(() => {
			throw new Error('summariser call failed')
		})
		const before = messages.length

		await runCompactionCheck(ctx)

		const event = failure(events)
		expect(event, 'the throw was swallowed into a log line').toBeDefined()
		expect(event?.cause).toBe('reducer_threw')
		expect(event?.error).toContain('summariser call failed')
		expect(event?.messages).toBe(before)
		expect(messages.length, 'the history must be untouched').toBe(before)
	})

	it('reports a reducer that shed nothing', async () => {
		// Distinct from the others in what it means: every later pass will
		// decline identically, so a host seeing this repeatedly knows the
		// reducer's floor disagrees with the trigger rather than that something
		// intermittent is happening.
		const { ctx, events, messages } = context((reduction: ContextReduction) => [
			...reduction.messages,
		])
		const before = messages.length

		await runCompactionCheck(ctx)

		expect(failure(events)?.cause).toBe('shed_nothing')
		expect(messages.length).toBe(before)
	})

	it('reports a result refused for splitting a tool pair', async () => {
		const { ctx, events, messages } = context(() => [
			{
				role: 'assistant',
				content: null,
				timestamp: 1,
				toolCalls: [
					{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{}' } },
				],
			} as Message,
		])
		const before = messages.length

		await runCompactionCheck(ctx)

		expect(failure(events)?.cause).toBe('split_tool_pair')
		expect(messages.length, 'a refused result must not be half-applied').toBe(before)
	})

	it('says nothing when the reducer actually sheds', async () => {
		// The event must not fire on success, or a host cannot tell the two
		// apart and the signal is worth nothing.
		const { ctx, events } = context((reduction: ContextReduction) => reduction.messages.slice(-2))

		await runCompactionCheck(ctx)

		expect(failure(events)).toBeUndefined()
		expect(events.some((e) => e.type === 'compaction_completed')).toBe(true)
	})
})
