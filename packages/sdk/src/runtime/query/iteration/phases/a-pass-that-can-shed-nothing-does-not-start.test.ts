import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import type { ContextReducer } from '../../../../compaction/reducer.js'
import { estimateMessagesTokens } from '../../../../compaction/token-estimate.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import type { PluginHookEvent, PluginHookResult } from '../../../../types/plugin/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * From the soft target to the summary trigger a salience pass runs on every
 * iteration. Once every narration is cut and every large result cleared it
 * can do nothing, and it still ran both hooks, announced itself and logged.
 * A pass that can shed nothing and is not at the trigger does not start. It
 * still starts at the trigger (the summary is what it is for), when the
 * provider forced it, and when a host reducer owns the reduction.
 */

const WINDOW = 2_000

function turn(options: {
	readonly measured: number
	readonly extra?: readonly Message[]
	readonly reducer?: ContextReducer
	readonly smallTurns?: number
}) {
	const config = CompactionConfigSchema.parse({
		strategy: 'salience',
		contextWindowTokens: WINDOW,
		triggerThreshold: 0.7,
		keepRecentMessages: 2,
		llmVerification: false,
	})
	const manager = new WorkingStateManager(config)
	const messages: Message[] = [{ role: 'system', content: 'Standing policy.' }]
	for (let i = 0; i < (options.smallTurns ?? 3); i += 1) {
		messages.push(
			{ role: 'user', content: `step ${i}` },
			{ role: 'assistant', content: 'short reply.' },
		)
	}
	messages.push(...(options.extra ?? []))
	messages.push({ role: 'user', content: 'current task' }, { role: 'assistant', content: 'on it' })
	const events: SessionEvent[] = []
	const hooks: PluginHookEvent[] = []
	const ctx = {
		turnConfig: { model: 'mock', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		...(options.reducer ? { contextReducer: options.reducer } : {}),
		tools: { toLLMTools: () => [] },
		provider: {
			chat: async () => ({ content: 'summary', usage: { promptTokens: 1, completionTokens: 1 } }),
		},
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		pluginManager: {
			executeHooks: vi.fn(async (event: PluginHookEvent): Promise<PluginHookResult[]> => {
				hooks.push(event)
				return []
			}),
		},
		recorder: {
			id: '38adc63f-8628-4f78-8554-036c8d7a57a0',
			sessionId: 's',
			turnId: 't',
			currentIteration: 2,
			messages,
			lastPromptTokens: options.measured,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: vi.fn(),
		},
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	return { ctx, messages, events, hooks }
}

const OLD_RESULT: Message[] = [
	{
		role: 'assistant',
		content: null,
		toolCalls: [{ id: 'old', type: 'function', function: { name: 'bash', arguments: '{}' } }],
	},
	{ role: 'tool', toolCallId: 'old', content: 'z '.repeat(1_600) },
]

describe('a salience pass between the soft target and the trigger', () => {
	it.each([3, 30, 120])(
		'does not start when nothing can be shed, however long the history (%i small turns)',
		async (smallTurns) => {
			const { ctx, messages, events, hooks } = turn({ measured: 1_200, smallTurns })
			const before = [...messages]
			await runCompactionCheck(ctx)
			expect(hooks).toEqual([])
			expect(events).toEqual([])
			expect(messages).toEqual(before)
		},
	)

	it('starts, brackets itself with both hooks and sheds when something old can be shed', async () => {
		const { ctx, messages, events, hooks } = turn({ measured: 1_200, extra: OLD_RESULT })
		const before = estimateMessagesTokens(messages)
		await runCompactionCheck(ctx)
		expect(hooks).toEqual(['pre_compact', 'post_compact'])
		expect(events.map((e) => e.type)).toContain('compaction_started')
		expect(events.map((e) => e.type)).toContain('compaction_tool_results_cleared')
		expect(estimateMessagesTokens(messages)).toBeLessThan(before)
	})

	it('still starts at the trigger when nothing can be shed: that is the summary path', async () => {
		const { ctx, hooks, events, messages } = turn({
			measured: 1_500,
			// User messages are never shed by the working set, so there is nothing for it to
			// take and a lot for the summary to fold.
			extra: Array.from({ length: 6 }, (_, i) => ({
				role: 'user' as const,
				content: `background ${i} `.repeat(300),
			})),
		})
		await runCompactionCheck(ctx)
		expect(hooks[0]).toBe('pre_compact')
		expect(events.map((e) => e.type)).toContain('compaction_started')
		// The summary itself, not just the announcement.
		expect(
			messages.some((m) => m.role === 'system' && m.source?.type === 'compaction-summary'),
		).toBe(true)
	})

	it('still starts when the provider forced it', async () => {
		const { ctx, hooks } = turn({ measured: 1_200 })
		await runCompactionCheck(ctx, { force: true })
		expect(hooks[0]).toBe('pre_compact')
	})

	it('still starts when a host reducer owns the reduction', async () => {
		const reducer = vi.fn(async () => undefined)
		const { ctx, hooks } = turn({ measured: 1_200, reducer })
		await runCompactionCheck(ctx)
		expect(hooks[0]).toBe('pre_compact')
		expect(reducer).toHaveBeenCalledTimes(1)
	})
})
