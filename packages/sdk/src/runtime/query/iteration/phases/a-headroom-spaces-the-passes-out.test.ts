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
 * A pass that sheds only to the soft target is needed again on the next turn,
 * and on every turn after it. With a headroom it sheds that much further, so
 * the next pass comes only when the headroom is used. The runtime's own check
 * is driven here, turn by turn, and the passes are counted for N turns and 4N.
 * The runs are a few dozen turns: the counts are exact at that length, and a
 * check over a long history costs ten times as much under coverage in CI.
 */

const WINDOW = 20_000
const SOFT = WINDOW * 0.5

function conversation(headroom: number | undefined) {
	const config = CompactionConfigSchema.parse({
		strategy: 'salience',
		contextWindowTokens: WINDOW,
		triggerThreshold: 0.95,
		keepRecentMessages: 6,
		llmVerification: false,
		...(headroom === undefined ? {} : { softTargetHeadroom: headroom }),
	})
	const messages: Message[] = [{ role: 'system', content: 'Standing policy.' }]
	const hooks: PluginHookEvent[] = []
	const events: SessionEvent[] = []
	const ctx = {
		turnConfig: { model: 'mock', tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: new WorkingStateManager(config),
		tools: { toLLMTools: () => [] },
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
			currentIteration: 1,
			messages,
			clearLastPromptTokens: vi.fn(),
		},
		emitEvent: async (event: SessionEvent) => {
			events.push(event)
		},
	} as unknown as IterationContext
	const addTurn = (n: number) => {
		messages.push(
			{ role: 'user', content: `step ${n}` },
			{
				role: 'assistant',
				content: `Narration. ${'the code runs fast and the test is ok. '.repeat(30)}`,
				timestamp: n,
			},
		)
	}
	return { ctx, messages, hooks, events, addTurn }
}

/** Fill to just under the soft target, then run `turns` turns, a check before each. */
async function run(turns: number, headroom: number | undefined) {
	const c = conversation(headroom)
	let n = 0
	while (estimateMessagesTokens(c.messages) < SOFT - 100) c.addTurn(++n)
	c.hooks.length = 0
	const stubbedOrder: number[] = []
	let highest = 0
	for (let t = 0; t < turns; t += 1) {
		c.addTurn(++n)
		const before = new Set(c.messages)
		await runCompactionCheck(c.ctx)
		for (const m of c.messages) {
			if (!before.has(m) && typeof m.content === 'string' && m.content.includes('… (elided')) {
				stubbedOrder.push(m.timestamp as number)
			}
		}
		highest = Math.max(highest, estimateMessagesTokens(c.messages))
	}
	return {
		passes: c.hooks.filter((h) => h === 'pre_compact').length,
		order: stubbedOrder,
		highest,
		tokens: estimateMessagesTokens(c.messages),
	}
}

describe('a headroom spaces the passes out', () => {
	it('is one pass per turn without one, for N turns and for 4N', async () => {
		const n = await run(10, undefined)
		const fourN = await run(40, undefined)
		expect(n.passes).toBe(10)
		expect(fourN.passes).toBe(40)
	})

	it('is the same as no headroom when it is zero', async () => {
		const none = await run(20, undefined)
		const zero = await run(20, 0)
		expect(zero).toEqual(none)
	})

	it('runs one pass per stretch of turns that uses the headroom, and the stretch is the same at 4N', async () => {
		// A turn adds about 330 tokens; a headroom of 0.1 of the window is 2,000.
		const n = await run(10, 0.1)
		const fourN = await run(40, 0.1)
		expect(n.passes).toBeGreaterThanOrEqual(2)
		expect(n.passes).toBeLessThanOrEqual(4)
		expect(fourN.passes).toBeGreaterThanOrEqual(n.passes * 3)
		expect(fourN.passes).toBeLessThanOrEqual(n.passes * 5)
		// Far fewer than one a turn.
		expect(fourN.passes).toBeLessThan(40 / 4)
	})

	it('holds the context under the soft target at every check, with or without headroom', async () => {
		for (const headroom of [undefined, 0.05, 0.1, 0.15]) {
			const result = await run(30, headroom)
			expect(result.highest).toBeLessThanOrEqual(SOFT)
		}
	})

	it('stubs the same narrations in the same order, only earlier', async () => {
		const today = await run(30, undefined)
		const roomy = await run(30, 0.1)
		expect(today.order.length).toBeGreaterThan(15)
		expect(roomy.order.length).toBeGreaterThanOrEqual(today.order.length)
		expect(roomy.order.slice(0, today.order.length)).toEqual(today.order)
		// Oldest first in both.
		expect([...today.order].sort((a, b) => a - b)).toEqual(today.order)
	})

	it('leaves the context lower on average, which is what the headroom costs', async () => {
		const today = await run(30, undefined)
		const roomy = await run(30, 0.1)
		expect(roomy.tokens).toBeLessThan(today.tokens + 1)
	})
})
