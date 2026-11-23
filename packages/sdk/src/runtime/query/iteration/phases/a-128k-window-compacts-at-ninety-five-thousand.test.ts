import { describe, expect, it, vi } from 'vitest'
import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import { MockLLMProvider } from '../../../../provider/mock.js'
import type { Message } from '../../../../types/message/index.js'
import type { PluginHookEvent } from '../../../../types/plugin/index.js'
import { NOOP_LOGGER } from '../../../../utils/log/create-logger.js'
import { measureContext, runCompactionCheck } from './compaction.js'
import type { IterationContext } from './context.js'

/**
 * Measured, not assumed: on a 128k window, with nothing configured, when does a pass start?
 *
 * The summary trigger is the window less the output reserve (20k) and the buffer (13k): 95,000
 * tokens. The salience strategy the terminal ships also holds the context at its soft target
 * (half the window, 64,000), but only when something can be shed. At the 39k a person pasted from
 * `/context`, neither fires.
 */

const WINDOW = 128_000

/** A history with nothing the salience pass could shed: short turns, no tool results. */
function quietHistory(): Message[] {
	return [
		{ role: 'user', content: 'start' },
		{ role: 'assistant', content: 'ok' },
		{ role: 'user', content: 'again' },
		{ role: 'assistant', content: 'ok' },
	]
}

/** A history with a stale, large tool result the salience pass could clear. */
function sheddableHistory(): Message[] {
	const messages: Message[] = [{ role: 'user', content: 'read the log' }]
	for (let i = 0; i < 6; i++) {
		messages.push({
			role: 'assistant',
			content: '',
			toolCalls: [
				{
					id: `c${i}`,
					type: 'function',
					function: { name: 'Read', arguments: '{}' },
				},
			],
		})
		messages.push({
			role: 'tool',
			toolCallId: `c${i}`,
			content: `line ${i}\n`.repeat(2_000),
		})
	}
	messages.push({ role: 'assistant', content: 'done' })
	messages.push({ role: 'user', content: 'thanks' })
	return messages
}

function context(
	messages: Message[],
	promptTokens: number,
	strategy: 'structured' | 'salience',
	providerAutoCompactLimit?: number,
) {
	const config = CompactionConfigSchema.parse({
		strategy,
		resetThreshold: 0.4,
		keepRecentMessages: 2,
		clearToolResults: true,
		keepRecentToolResults: 1,
		minToolResultCharsToClear: 1_000,
		softTargetHeadroom: 0.05,
		llmVerification: false,
	})
	const manager = new WorkingStateManager(config)
	manager.setTask('keep going')
	const events: PluginHookEvent[] = []
	const provider = new MockLLMProvider({ turns: [{ text: '- a summary' }] })
	const ctx = {
		turnConfig: { model: 'gpt-6.2-sol', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		provider,
		// The window is the provider's own statement, so the table is not what is measured.
		providerContextWindow: WINDOW,
		...(providerAutoCompactLimit !== undefined ? { providerAutoCompactLimit } : {}),
		tools: { toLLMTools: () => [] },
		log: NOOP_LOGGER,
		abortController: new AbortController(),
		pluginManager: {
			executeHooks: vi.fn(async (event: PluginHookEvent) => {
				events.push(event)
				return []
			}),
		},
		recorder: {
			id: '38adc63f-8628-4f78-8554-036c8d7a57a0',
			sessionId: 's',
			turnId: 't',
			currentIteration: 1,
			messages,
			lastPromptTokens: promptTokens,
			lastPromptMessageCount: messages.length,
			clearLastPromptTokens: vi.fn(),
			accumulateUsage: vi.fn(),
		},
		emitEvent: async () => {},
	} as unknown as IterationContext
	return { ctx, events }
}

async function started(
	history: Message[],
	promptTokens: number,
	strategy: 'structured' | 'salience',
	providerAutoCompactLimit?: number,
) {
	const { ctx, events } = context(history, promptTokens, strategy, providerAutoCompactLimit)
	await runCompactionCheck(ctx)
	return events.includes('pre_compact')
}

describe('compaction on a 128k window with nothing configured', () => {
	it.each(['structured', 'salience'] as const)(
		'does not start at the 39k a person saw (%s)',
		async (strategy) => {
			expect(await started(sheddableHistory(), 39_000, strategy)).toBe(false)
		},
	)

	it.each(['structured', 'salience'] as const)(
		'does not start just under 95,000 tokens, and starts at it (%s)',
		async (strategy) => {
			expect(await started(quietHistory(), 94_900, strategy)).toBe(false)
			expect(await started(quietHistory(), 95_000, strategy)).toBe(true)
		},
	)

	it('holds the salience soft target at half the window, and only when something can be shed', async () => {
		expect(await started(sheddableHistory(), 63_000, 'salience')).toBe(false)
		expect(await started(sheddableHistory(), 65_000, 'salience')).toBe(true)
		// Nothing to shed: no pass until the summary trigger.
		expect(await started(quietHistory(), 65_000, 'salience')).toBe(false)
		// The structured strategy has no soft target.
		expect(await started(sheddableHistory(), 65_000, 'structured')).toBe(false)
	})
})

describe('the compaction limit the provider reports', () => {
	it('starts the pass at the provider limit when it is under 90% of the window', async () => {
		expect(await started(quietHistory(), 99_900, 'structured', 100_000)).toBe(false)
		expect(await started(quietHistory(), 100_000, 'structured', 100_000)).toBe(true)
	})

	it('holds a provider limit above 90% of the window to 90% (115,200 tokens)', async () => {
		expect(await started(quietHistory(), 115_100, 'structured', 127_000)).toBe(false)
		expect(await started(quietHistory(), 115_200, 'structured', 127_000)).toBe(true)
	})

	it('keeps the usual rule when the provider reports none', async () => {
		expect(await started(quietHistory(), 94_900, 'structured', undefined)).toBe(false)
		expect(await started(quietHistory(), 95_000, 'structured', undefined)).toBe(true)
	})
})

describe('what the trigger measures', () => {
	it('is the provider-reported prompt, not a sum with the cached or reasoning share', () => {
		// A driver reports the whole prompt (cached tokens are part of it) and puts reasoning in the
		// completion count; the trigger reads the prompt size alone, so neither is added a second time.
		const { ctx } = context(quietHistory(), 39_000, 'salience')
		expect(measureContext(ctx)).toEqual({ tokens: 39_000, source: 'provider' })
	})
})
