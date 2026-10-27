import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import type { CompactionSummaryRouter } from '../../../../compaction/model-summary.js'
import { COMPACTION_HEADER } from '../../../../compaction/summary.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { CompactionConfig } from '../../../../config/runtime.js'
import { MockLLMProvider } from '../../../../provider/mock.js'
import type { Message } from '../../../../types/message/index.js'
import { runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * An automatic pass asks the model the host set aside for the summary, puts
 * its cost on the turn's ledger at that model's price, and keeps the
 * extracted summary whenever that model gives nothing usable.
 */

const SUMMARY = `<summary>
Current work: porting the loader.
Next step: fix the empty path case.
</summary>`

function harness(
	summaryRoute: CompactionSummaryRouter | undefined,
	over: Partial<CompactionConfig> = {},
) {
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
		contextWindowTokens: 100_000,
		keepRecentMessages: 4,
		llmVerification: false,
		richStateThreshold: 1_000,
		triggerThreshold: 0.01,
		...over,
	}
	const accumulateUsage = vi.fn()
	const warn = vi.fn()
	const ctx = {
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		turnConfig: { model: 'primary-model' },
		tools: { listNames: () => [] },
		recorder: {
			id: '0b69064f-36a8-4ec0-87c8-5ec601789313',
			messages,
			servingProviderId: 'main-provider',
			accumulateUsage,
			clearLastPromptTokens: vi.fn(),
		},
		...(summaryRoute ? { compactionSummaryRoute: summaryRoute } : {}),
		abortController: new AbortController(),
		log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
	} as unknown as IterationContext
	return { ctx, accumulateUsage, warn }
}

const summaryOf = (ctx: IterationContext): string =>
	String(
		ctx.recorder.messages.find(
			(m) => typeof m.content === 'string' && m.content.startsWith(COMPACTION_HEADER),
		)?.content,
	)

describe('an automatic pass with a model set aside for the summary', () => {
	it('uses its summary and charges the turn at that model’s price', async () => {
		const small = new MockLLMProvider({
			turns: [
				{ text: SUMMARY, usage: { promptTokens: 700, completionTokens: 60, totalTokens: 760 } },
			],
		})
		const h = harness(async () => ({
			provider: small,
			model: 'small-1',
			providerId: 'small-provider',
		}))

		await runCompactionCheck(h.ctx, { force: true })

		expect(summaryOf(h.ctx)).toContain('Next step: fix the empty path case.')
		expect(small.requests).toHaveLength(1)
		expect(h.accumulateUsage).toHaveBeenCalledTimes(1)
		expect(h.accumulateUsage).toHaveBeenCalledWith(expect.objectContaining({ totalTokens: 760 }), {
			providerId: 'small-provider',
			model: 'small-1',
		})
	})

	it('prices the call at the turn’s provider when the route names none', async () => {
		const small = new MockLLMProvider({ turns: [{ text: SUMMARY }] })
		const h = harness(async () => ({ provider: small, model: 'small-1' }))
		await runCompactionCheck(h.ctx, { force: true })
		expect(h.accumulateUsage).toHaveBeenCalledWith(expect.anything(), {
			providerId: 'main-provider',
			model: 'small-1',
		})
	})

	it('keeps the extracted summary, and the turn going, when the call fails', async () => {
		const small = new MockLLMProvider({ turns: [{ error: { message: 'down', status: 503 } }] })
		const h = harness(async () => ({ provider: small, model: 'small-1' }))

		await runCompactionCheck(h.ctx, { force: true })

		expect(summaryOf(h.ctx)).toContain(COMPACTION_HEADER)
		expect(summaryOf(h.ctx)).not.toContain('Next step: fix')
		expect(h.accumulateUsage).not.toHaveBeenCalled()
		expect(h.warn).toHaveBeenCalled()
	})

	it('keeps the extracted summary when no model is set aside', async () => {
		const h = harness(async () => undefined)
		await runCompactionCheck(h.ctx, { force: true })
		expect(summaryOf(h.ctx)).toContain(COMPACTION_HEADER)
		expect(summaryOf(h.ctx)).not.toContain('Next step: fix')
		expect(h.warn).not.toHaveBeenCalled()
	})

	it('asks for nothing when the host turned the model summary off', async () => {
		const route = vi.fn(async () => undefined)
		const h = harness(route, { modelSummary: false })
		await runCompactionCheck(h.ctx, { force: true })
		expect(route).not.toHaveBeenCalled()
	})
})
