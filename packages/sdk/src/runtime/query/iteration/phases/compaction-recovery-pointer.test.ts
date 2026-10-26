import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { COMPACTION_HEADER, COMPACTION_RECOVERY_NOTE } from '../../../../compaction/summary.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import type { Message } from '../../../../types/message/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * A summary points at the originals only when both tools it names are mounted
 * in the turn that wrote it.
 */

function harness(toolNames: string[]): { ctx: IterationContext } {
	const messages: Message[] = [
		{ role: 'system', content: 'prompt', timestamp: 1 },
		...Array.from({ length: 40 }, (_, i) => ({
			role: 'user' as const,
			content: `turn ${i} `.repeat(200),
			timestamp: 1,
		})),
	]
	const config: CompactionConfig = {
		...CompactionConfigSchema.parse({}),
		contextWindowTokens: 1_000,
		keepRecentMessages: 4,
		llmVerification: true,
		// Keep the slot count under the rich-state threshold so the verified
		// summary path — the one that calls a model — is the one taken.
		richStateThreshold: 1_000,
	}
	const abortController = new AbortController()

	const ctx = {
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		turnConfig: { model: 'primary-model' },
		tools: { listNames: () => toolNames },
		recorder: {
			id: '0b69064f-36a8-4ec0-87c8-5ec601789313',
			messages,
			accumulateUsage: vi.fn(),
			clearLastPromptTokens: vi.fn(),
		},
		provider: {
			chatStream: async function* () {
				yield { id: 'c1', delta: { content: 'a summary' } }
				yield {
					id: 'c1',
					delta: {},
					finishReason: 'stop',
					usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				}
			},
		},
		abortController,
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	} as unknown as IterationContext

	return { ctx }
}

describe('the pointer at the end of an in-turn compaction summary', () => {
	const summaryOf = (ctx: IterationContext): string => {
		const found = ctx.recorder.messages.find(
			(m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER),
		)
		return String(found?.content)
	}

	it('is added when both conversation tools are mounted', async () => {
		const h = harness(['read', 'search_conversation', 'read_conversation'])

		await runCompactionCheck(h.ctx)

		expect(summaryOf(h.ctx).endsWith(`\n\n${COMPACTION_RECOVERY_NOTE}`)).toBe(true)
	})

	it.each([[['read']], [['search_conversation']], [['read_conversation', 'read']]])(
		'is left out when the tools it names are not both there (%j)',
		async (names) => {
			const h = harness(names)

			await runCompactionCheck(h.ctx)

			expect(summaryOf(h.ctx)).toContain(COMPACTION_HEADER)
			expect(summaryOf(h.ctx)).not.toContain('search_conversation, then')
		},
	)
})
