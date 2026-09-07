import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { isClearedToolResult } from '../../../../compaction/tool-result-editing.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import { RunQuery } from '../../../../run-query/index.js'
import { InMemoryRunStore } from '../../../../store/run/memory.js'
import type { Message } from '../../../../types/message/index.js'
import type { Run, RunEvent } from '../../../../types/run/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

const BODY = `${'head '.repeat(500)}ACCOUNT_EVIDENCE_IN_THE_MIDDLE${' tail'.repeat(500)}`

async function context(
	options: {
		strategy?: 'structured' | 'salience'
		force?: boolean
		recordShedHistory?: boolean
		refuseArchive?: boolean
	} = {},
) {
	const config = CompactionConfigSchema.parse({
		strategy: options.strategy ?? 'structured',
		contextWindowTokens: 6_000,
		triggerThreshold: 0.7,
		keepRecentMessages: options.force ? 8 : 2,
		keepRecentToolResults: 0,
		llmVerification: false,
		recordShedHistory: options.recordShedHistory ?? true,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('Continue the current job.')
	const messages: Message[] = [
		{ role: 'system', content: 'policy '.repeat(1_000) },
		{ role: 'user', content: 'old job' },
		{
			role: 'assistant',
			content: '',
			toolCalls: [{ id: 'job-1', type: 'function', function: { name: 'job', arguments: '{}' } }],
		},
		{ role: 'tool', toolCallId: 'job-1', content: BODY },
		{ role: 'user', content: 'current job' },
		{ role: 'assistant', content: 'working' },
	]
	const store = new InMemoryRunStore()
	await store.initRun('70f44a33-f56a-4b59-bf2e-d722397f9382')
	const archiveSawOriginal = vi.fn()
	const invalidate = vi.fn()
	const ctx = {
		runConfig: { model: 'mock' },
		compactionConfig: config,
		workingStateManager: manager,
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		runMgr: {
			id: '70f44a33-f56a-4b59-bf2e-d722397f9382',
			currentIteration: 3,
			messages,
			lastPromptTokens: 4_500,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: invalidate,
		},
		emitEvent: async (event: RunEvent) => {
			if (event.type === 'compaction_shed') {
				archiveSawOriginal(messages[3]?.content === BODY)
				if (options.refuseArchive) throw new Error('archive write refused')
			}
			await store.appendEvent(event)
		},
	} as unknown as IterationContext
	return { ctx, messages, store, archiveSawOriginal, invalidate }
}

describe('clear-only compaction preserves recoverable original evidence', () => {
	it.each([
		{ strategy: 'structured' as const, force: false },
		{ strategy: 'salience' as const, force: false },
		{ strategy: 'structured' as const, force: true },
	])('archives before $strategy clearing (overflow=$force)', async (options) => {
		const { ctx, messages, store, archiveSawOriginal } = await context(options)
		await runCompactionCheck(ctx, { force: options.force })
		expect(isClearedToolResult(messages[3]?.content)).toBe(true)
		expect(messages[3]?.content).not.toContain('ACCOUNT_EVIDENCE_IN_THE_MIDDLE')
		expect(archiveSawOriginal).toHaveBeenCalledExactlyOnceWith(true)
		const events = await store.readEvents()
		expect(events.map((event) => event.type)).toEqual([
			'compaction_shed',
			'compaction_tool_results_cleared',
			'token_usage_updated',
		])
		await store.writeMessages({ messages } as Run, events.at(-1)?.seq ?? 0)
		const query = new RunQuery({ store })
		expect(await query.shedHistory()).toMatchObject([
			{
				reason: options.force ? 'overflow' : 'threshold',
				messages: [{ role: 'tool', toolCallId: 'job-1', content: BODY }],
			},
		])
		const full = await query.fullTranscript()
		expect(full.filter((message) => message.content === BODY)).toHaveLength(1)
		expect(full).toContainEqual(messages[3])
	})

	it('honors the explicit archive opt-out', async () => {
		const { ctx, messages, store, archiveSawOriginal } = await context({ recordShedHistory: false })
		await runCompactionCheck(ctx)
		expect(isClearedToolResult(messages[3]?.content)).toBe(true)
		expect(archiveSawOriginal).not.toHaveBeenCalled()
		expect(await new RunQuery({ store }).shedHistory()).toEqual([])
	})

	it('keeps the original live history when its archive cannot be recorded', async () => {
		const { ctx, messages, store, invalidate } = await context({ refuseArchive: true })
		const original = [...messages]
		await expect(runCompactionCheck(ctx)).rejects.toThrow('archive write refused')
		expect(messages).toEqual(original)
		expect(messages[3]?.content).toBe(BODY)
		expect(invalidate).not.toHaveBeenCalled()
		expect(await store.readEvents()).toEqual([])
	})
})
