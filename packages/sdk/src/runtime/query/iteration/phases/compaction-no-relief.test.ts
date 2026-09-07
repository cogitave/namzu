import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { serializeState } from '../../../../compaction/serializer.js'
import { buildCompactionMessage } from '../../../../compaction/summary.js'
import { estimateMessagesTokens } from '../../../../compaction/token-estimate.js'
import { isClearedToolResult } from '../../../../compaction/tool-result-editing.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import type { RunEvent } from '../../../../types/run/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

function context(
	options: {
		retained?: boolean
		clear?: boolean
		strategy?: 'salience' | 'structured'
		lastPromptTokens?: number
	} = {},
) {
	const config = CompactionConfigSchema.parse({
		strategy: options.strategy ?? 'salience',
		contextWindowTokens: 2_000,
		triggerThreshold: 0.7,
		resetThreshold: 0.4,
		keepRecentMessages: 2,
		clearToolResults: options.clear ?? false,
		keepRecentToolResults: 0,
		llmVerification: false,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('Repair the configuration without changing its tenant.')
	for (let i = 0; i < 5; i++) {
		manager.addDecision(
			`Decision ${i}: associate the account and action receipt with the originating job.`,
		)
	}
	const messages: Message[] = [
		{ role: 'system', content: 'Standing policy. '.repeat(360) },
		{ role: 'user', content: 'old task', retain: options.retained },
		{ role: 'assistant', content: 'old reply', retain: options.retained },
		{ role: 'user', content: 'current task' },
		{ role: 'assistant', content: 'working' },
	]
	const events: RunEvent[] = []
	const invalidate = vi.fn()
	const ctx = {
		runConfig: { model: 'mock', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		runMgr: {
			id: '38adc63f-8628-4f78-8554-036c8d7a57a0',
			currentIteration: 1,
			messages,
			lastPromptTokens: options.lastPromptTokens ?? 1_900,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: invalidate,
		},
		emitEvent: async (event: RunEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	return { ctx, messages, manager, events, invalidate }
}

describe('a structured summary must reclaim estimated prompt space', () => {
	it.each([false, true])(
		'keeps an expanding candidate off the wire (retained=%s)',
		async (retained) => {
			const { ctx, messages, events, invalidate } = context({ retained })
			const original = [...messages]
			const before = estimateMessagesTokens(messages)
			await runCompactionCheck(ctx)
			await runCompactionCheck(ctx)
			expect(messages).toEqual(original)
			for (const [index, message] of original.entries()) expect(messages[index]).toBe(message)
			expect(estimateMessagesTokens(messages)).toBe(before)
			expect(invalidate).not.toHaveBeenCalled()
			expect(events.filter((event) => event.type === 'compaction_failed')).toMatchObject([
				{ cause: 'shed_nothing' },
				{ cause: 'shed_nothing' },
			])
			expect(
				events.some((event) =>
					['compaction_completed', 'compaction_shed', 'token_usage_updated'].includes(event.type),
				),
			).toBe(false)
		},
	)

	it('does not replace an equivalent summary merely to publish another successful pass', async () => {
		const { ctx, messages, manager, events, invalidate } = context({ retained: true })
		messages.splice(1, 0, buildCompactionMessage(serializeState(manager.getState())))
		const original = [...messages]
		await runCompactionCheck(ctx)
		expect(messages).toEqual(original)
		expect(messages[1]).toBe(original[1])
		expect(invalidate).not.toHaveBeenCalled()
		expect(events).toMatchObject([{ type: 'compaction_failed', cause: 'shed_nothing' }])
	})

	it('still commits a summary that replaces substantially larger unretained history', async () => {
		const { ctx, messages, events, invalidate } = context()
		messages[1] = { role: 'user', content: 'Historical details. '.repeat(500) }
		const before = estimateMessagesTokens(messages)
		await runCompactionCheck(ctx)
		expect(estimateMessagesTokens(messages)).toBeLessThan(before)
		expect(events.some((event) => event.type === 'compaction_completed')).toBe(true)
		expect(events.some((event) => event.type === 'compaction_failed')).toBe(false)
		expect(invalidate).toHaveBeenCalledOnce()
	})

	it('publishes a useful staged clear without spending its savings on a larger summary', async () => {
		const { ctx, messages, manager, events, invalidate } = context({
			clear: true,
			strategy: 'structured',
			lastPromptTokens: 6_000,
		})
		for (let i = 5; i < 25; i++)
			manager.addDecision(`Decision ${i}: ${'keep the scoped receipt. '.repeat(8)}`)
		messages.splice(
			2,
			1,
			{
				role: 'assistant',
				content: '',
				toolCalls: [
					{ id: 'read-1', type: 'function', function: { name: 'read', arguments: '{}' } },
				],
			},
			{ role: 'tool', toolCallId: 'read-1', content: 'record '.repeat(1_000) },
		)
		const before = estimateMessagesTokens(messages)
		const count = messages.length
		await runCompactionCheck(ctx)
		expect(estimateMessagesTokens(messages)).toBeLessThan(before)
		expect(messages).toHaveLength(count)
		expect(isClearedToolResult(messages[3]?.content)).toBe(true)
		expect(events.some((event) => event.type === 'compaction_tool_results_cleared')).toBe(true)
		expect(
			events.some((event) => ['compaction_completed', 'compaction_failed'].includes(event.type)),
		).toBe(false)
		expect(invalidate).toHaveBeenCalledOnce()
	})
})
