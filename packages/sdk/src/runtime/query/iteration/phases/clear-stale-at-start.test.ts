import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { isClearedToolResult } from '../../../../compaction/tool-result-editing.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { compactionBreaker } from './compaction-breaker.js'
import { runStaleResultClear } from './compaction.js'
import type { IterationContext } from './context.js'

const BIG = `${'line of output '.repeat(2_000)}`

/** `steps` read steps, each a call and a large result, then the new request. */
function history(steps: number): Message[] {
	const messages: Message[] = [
		{ role: 'system', content: 'policy' },
		{ role: 'user', content: 'go' },
	]
	for (let i = 0; i < steps; i++) {
		messages.push({
			role: 'assistant',
			content: '',
			toolCalls: [
				{ id: `c${i}`, type: 'function', function: { name: 'read_file', arguments: '{}' } },
			],
		})
		messages.push({ role: 'tool', toolCallId: `c${i}`, content: `${BIG}#${i}` })
	}
	messages.push({ role: 'user', content: 'now what' })
	return messages
}

function context(
	messages: Message[],
	option: { minSavedTokens: number; keepRecentToolResults?: number } | undefined,
	extra: Record<string, unknown> = {},
) {
	const events: SessionEvent[] = []
	const invalidate = vi.fn()
	const config = CompactionConfigSchema.parse({
		contextWindowTokens: 1_000_000,
		...extra,
		...(option ? { clearStaleToolResultsAtStart: option } : {}),
	})
	const ctx = {
		turnConfig: { model: 'mock' },
		compactionConfig: config,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		recorder: {
			turnId: 't',
			currentIteration: 1,
			messages,
			tokenUsage: {},
			costInfo: {},
			clearLastPromptTokens: invalidate,
		},
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	return { ctx, events, invalidate }
}

describe('clearing stale tool results at the start of a turn', () => {
	it('clears the old results, records the originals first, and reports it', async () => {
		const messages = history(12)
		const original = [...messages]
		const { ctx, events } = context(messages, { minSavedTokens: 1_000, keepRecentToolResults: 4 })
		await runStaleResultClear(ctx)
		const tools = messages.filter((m) => m.role === 'tool')
		expect(tools.slice(0, 8).every((m) => isClearedToolResult(m.content))).toBe(true)
		// The last four results, and everything that is not a result, are untouched.
		expect(tools.slice(8)).toEqual(original.filter((m) => m.role === 'tool').slice(8))
		expect(messages.filter((m) => m.role !== 'tool')).toEqual(
			original.filter((m) => m.role !== 'tool'),
		)
		expect(events.map((e) => e.type)).toEqual([
			'compaction_shed',
			'compaction_tool_results_cleared',
			'token_usage_updated',
		])
		const shed = events[0] as Extract<SessionEvent, { type: 'compaction_shed' }>
		expect(shed.reason).toBe('manual')
		// The bodies the model no longer sees are what the log kept.
		expect(shed.messages).toHaveLength(8)
		expect(shed.messages[0]).toEqual(original[3])
		// The placeholder names the tool and its size so the model can re-run it.
		expect(String(tools[0]?.content)).toContain('read_file returned')
	})

	it('does nothing when the saving is below the floor', async () => {
		const messages = history(12)
		const original = [...messages]
		const { ctx, events } = context(messages, { minSavedTokens: 10_000_000 })
		await runStaleResultClear(ctx)
		expect(messages).toEqual(original)
		expect(events).toEqual([])
	})

	it('does nothing when the host did not ask', async () => {
		const messages = history(12)
		const original = [...messages]
		const { ctx, events } = context(messages, undefined)
		await runStaleResultClear(ctx)
		expect(messages).toEqual(original)
		expect(events).toEqual([])
	})

	it('leaves pinned results and short histories alone', async () => {
		const messages = history(12)
		messages[3] = { ...messages[3], retain: true } as Message
		const { ctx } = context(messages, { minSavedTokens: 1_000, keepRecentToolResults: 4 })
		await runStaleResultClear(ctx)
		// The pin pulls its whole call in; the result keeps its full text.
		expect(isClearedToolResult(messages[3]?.content)).toBe(false)
		const short = history(3)
		const copy = [...short]
		await runStaleResultClear(
			context(short, { minSavedTokens: 1_000, keepRecentToolResults: 4 }).ctx,
		)
		expect(short).toEqual(copy)
	})

	it('does not run when the shed history is switched off, so no original is lost unrecorded', async () => {
		const messages = history(12)
		const original = [...messages]
		const { ctx, events } = context(
			messages,
			{ minSavedTokens: 1_000, keepRecentToolResults: 4 },
			{ recordShedHistory: false },
		)
		await runStaleResultClear(ctx)
		expect(messages).toEqual(original)
		expect(events).toEqual([])
	})

	it('does not reset the circuit breaker failure streak', async () => {
		const { ctx, events } = context(
			history(12),
			{ minSavedTokens: 1_000, keepRecentToolResults: 4 },
			{ circuitBreaker: true },
		)
		const breaker = compactionBreaker(ctx)
		breaker?.recordFailure()
		breaker?.recordFailure()
		await runStaleResultClear(ctx)
		expect(events.map((e) => e.type)).toContain('compaction_tool_results_cleared')
		breaker?.recordFailure()
		expect(breaker?.failuresOpen).toBe(true)
	})

	it('runs from exactly one place, the first iteration of a turn', () => {
		const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
		const calls = source.split('\n').filter((line) => line.includes('runStaleResultClear('))
		expect(calls).toHaveLength(1)
		expect(calls[0]).toContain('iterationNum === 1')
	})
})
