import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { estimateMessagesTokens } from '../../../../compaction/token-estimate.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import type { PluginHookEvent, PluginHookResult } from '../../../../types/plugin/index.js'
import type { SessionEvent } from '../../../../types/session/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * A `pre_compact` hook may cancel a pass the threshold asked for, and may not
 * cancel one the provider forced: a context the provider will reject is not
 * something a hook may insist on.
 */

function turn(answer: PluginHookResult) {
	const config = CompactionConfigSchema.parse({
		strategy: 'salience',
		contextWindowTokens: 2_000,
		triggerThreshold: 0.7,
		resetThreshold: 0.4,
		keepRecentMessages: 2,
		clearToolResults: false,
		keepRecentToolResults: 0,
		llmVerification: false,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('Repair the configuration without changing its tenant.')
	for (let i = 0; i < 5; i++) manager.addDecision(`Decision ${i}: keep the originating job.`)
	const messages: Message[] = [
		{ role: 'system', content: 'Standing policy. '.repeat(360) },
		{ role: 'user', content: 'Historical details. '.repeat(500) },
		{ role: 'assistant', content: 'old reply' },
		{ role: 'user', content: 'current task' },
		{ role: 'assistant', content: 'working' },
	]
	const events: SessionEvent[] = []
	const hooks: PluginHookEvent[] = []
	const ctx = {
		turnConfig: { model: 'mock', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		pluginManager: {
			executeHooks: vi.fn(async (event: PluginHookEvent): Promise<PluginHookResult[]> => {
				hooks.push(event)
				return event === 'pre_compact' ? [answer] : []
			}),
		},
		recorder: {
			id: '38adc63f-8628-4f78-8554-036c8d7a57a0',
			sessionId: 's',
			turnId: 't',
			currentIteration: 1,
			messages,
			lastPromptTokens: 1_900,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: vi.fn(),
		},
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	return { ctx, messages, events, hooks }
}

describe('a pre_compact hook that refuses', () => {
	it('cancels a threshold pass: nothing is compacted and post_compact does not fire', async () => {
		const { ctx, messages, events, hooks } = turn({
			action: 'skip',
			reason: 'not now',
		})
		const before = estimateMessagesTokens(messages)
		await runCompactionCheck(ctx)
		expect(estimateMessagesTokens(messages)).toBe(before)
		expect(events.some((event) => event.type === 'compaction_completed')).toBe(false)
		expect(hooks).toEqual(['pre_compact'])
	})

	it('does not cancel a pass the provider forced', async () => {
		const { ctx, messages, hooks } = turn({
			action: 'skip',
			reason: 'not now',
		})
		const before = estimateMessagesTokens(messages)
		await runCompactionCheck(ctx, { force: true })
		expect(estimateMessagesTokens(messages)).toBeLessThan(before)
		expect(hooks).toEqual(['pre_compact', 'post_compact'])
	})

	it('lets a pass run when the hook says continue', async () => {
		const { ctx, messages, hooks } = turn({ action: 'continue' })
		const before = estimateMessagesTokens(messages)
		await runCompactionCheck(ctx)
		expect(estimateMessagesTokens(messages)).toBeLessThan(before)
		expect(hooks).toEqual(['pre_compact', 'post_compact'])
	})
})
