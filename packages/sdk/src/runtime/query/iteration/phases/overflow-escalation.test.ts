/**
 * A forced compaction pass runs because the PROVIDER rejected the prompt
 * as too long. Two things let it decline to do anything about that:
 *
 *   1. After clearing stale tool results it re-applied the chars/4
 *      estimate — the very estimate the provider had just refuted — and
 *      returned early if that said the context was fine. So relief could
 *      report success after clearing one short result, and the retry
 *      overflowed again.
 *   2. Relief reported success on ANY positive shed. A one-character shed
 *      counted, and the retry burned a whole model call to be told the
 *      same thing.
 */

import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { RunId } from '../../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { relieveOverflow } from './compaction.js'
import type { IterationContext } from './context.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const bulk = (chars: number) => 'x'.repeat(chars)

function makeCtx(messages: Message[]): { ctx: IterationContext; log: Logger } {
	const config = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		// Large on purpose: the estimate must read as COMFORTABLE, which is
		// exactly the state in which the provider still rejected the prompt.
		// That is the case the early return used to mishandle.
		contextWindowTokens: 1_000_000,
	})
	const manager = new WorkingStateManager(config)
	manager.addDecision('kept going')
	const log = makeLogger()

	const ctx = {
		runConfig: { tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		log,
		tools: { toLLMTools: () => [] },
		runMgr: {
			id: 'run_1' as RunId,
			currentIteration: 6,
			messages,
			lastPromptTokens: undefined,
			lastPromptMessageCount: undefined,
			clearLastPromptTokens: () => {},
			accumulateUsage: () => {},
		},
		emitEvent: async () => {},
	} as unknown as IterationContext

	return { ctx, log }
}

/** A history with plenty of older turns and one huge stale tool result. */
function overflowingHistory(): Message[] {
	const messages: Message[] = [createSystemMessage('system floor')]
	for (let i = 0; i < 8; i++) {
		messages.push(createUserMessage(`turn ${i} ${bulk(400)}`))
		messages.push({
			...createAssistantMessage(''),
			toolCalls: [
				{ id: `t${i}`, type: 'function' as const, function: { name: 'read', arguments: '{}' } },
			],
		} as Message)
		messages.push(createToolMessage(bulk(i === 0 ? 60_000 : 800), `t${i}`))
	}
	return messages
}

describe('a forced pass on a context the estimate thinks is fine', () => {
	it('does not stop after clearing one tool result', async () => {
		const messages = overflowingHistory()
		const { ctx } = makeCtx(messages)
		const before = messages.length

		await relieveOverflow(ctx)

		// The estimate said the context was comfortable — the provider had
		// just said otherwise. Compaction, not the estimate, gets to decide
		// whether a forced pass is done.
		expect(ctx.runMgr.messages.length).toBeLessThan(before)
	})

	it('reports relief when it actually shed something substantial', async () => {
		const { ctx } = makeCtx(overflowingHistory())
		expect(await relieveOverflow(ctx)).toBe(true)
	})
})

describe('what counts as relief', () => {
	it('refuses when there is nothing at all to shed', async () => {
		const { ctx, log } = makeCtx([
			createSystemMessage('system floor'),
			createUserMessage(bulk(200)),
		])

		expect(await relieveOverflow(ctx)).toBe(false)
		expect(
			(log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(([message]) =>
				String(message).includes('irreducible'),
			),
		).toBe(true)
	})

	it('refuses a POSITIVE shed too small to change the provider verdict', async () => {
		// Many short turns: a forced pass genuinely sheds something, but
		// only a few hundred characters — nowhere near enough to move a
		// prompt the provider has already rejected. Any positive shed used
		// to count, so the caller retried and burned a whole model call to
		// be told the same thing.
		const messages: Message[] = [createSystemMessage('floor')]
		for (let i = 0; i < 14; i++) {
			messages.push(createUserMessage(`u${i} ${bulk(30)}`))
			messages.push(createAssistantMessage(`a${i} ${bulk(30)}`))
		}
		const before = messages.reduce(
			(sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
			0,
		)

		const { ctx } = makeCtx(messages)
		const relieved = await relieveOverflow(ctx)

		const after = ctx.runMgr.messages.reduce(
			(sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0),
			0,
		)
		const shed = before - after
		// The premise of the case: something WAS shed, just not enough.
		expect(shed).toBeGreaterThan(0)
		expect(shed).toBeLessThan(2_000)
		expect(relieved).toBe(false)
	})

	it('says how much it shed and how much was needed', async () => {
		const { ctx, log } = makeCtx([createSystemMessage('floor'), createUserMessage(bulk(200))])
		await relieveOverflow(ctx)

		const warned = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
		expect(warned?.[1]).toMatchObject({ 'namzu.runtime.chars_shed': expect.any(Number) })
		expect(
			(warned?.[1] as Record<string, number>)['namzu.runtime.needed_at_least'],
		).toBeGreaterThan(0)
	})
})
