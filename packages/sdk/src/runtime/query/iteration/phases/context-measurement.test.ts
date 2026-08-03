/**
 * What the compaction trigger believes the context costs.
 *
 * Two omissions pointed the same way — under-count — so the threshold did
 * not jitter around the mark, it sat systematically late:
 *
 *   1. The provider's prompt measurement describes the request as it was
 *      SENT. Everything the turn appended afterwards — the assistant
 *      message and every one of its tool results — fell outside it, and
 *      the reading was taken verbatim. The staleness is largest on exactly
 *      the turns that add the most.
 *   2. The tool catalogue is assembled separately from the message array
 *      and never entered the fallback estimate at all. A 30-tool registry
 *      is easily 10-20k tokens of JSON Schema.
 *
 * Each case is written so the pre-fix reading lands BELOW the trigger and
 * the corrected one lands above: compaction either fires or it does not,
 * which is a sharper signal than a number in a log line.
 */

import { describe, expect, it, vi } from 'vitest'

import { WorkingStateManager } from '../../../../compaction/manager.js'
import { CompactionConfigSchema } from '../../../../config/runtime.js'
import type { RunId } from '../../../../types/ids/index.js'
import {
	type Message,
	createAssistantMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../../types/message/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { runCompactionCheck } from './compaction.js'
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

/** The one log line that reports what the trigger measured. */
function compactionLog(log: Logger): Record<string, unknown> | undefined {
	const calls = (log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
	const hit = calls.find((call) => String(call[0]).includes('Compaction threshold reached'))
	return hit?.[1] as Record<string, unknown> | undefined
}

const WINDOW = 2_500

function makeCtx(opts: {
	messages: Message[]
	lastPromptTokens?: number
	lastPromptMessageCount?: number
	tools?: unknown[]
}): { ctx: IterationContext; log: Logger } {
	const config = CompactionConfigSchema.parse({
		strategy: 'structured',
		llmVerification: false,
		contextWindowTokens: WINDOW,
		triggerThreshold: 0.7,
	})
	const manager = new WorkingStateManager(config)
	manager.addDecision('kept going')
	const log = makeLogger()

	const ctx = {
		runConfig: { tokenBudget: 0 },
		compactionConfig: config,
		workingStateManager: manager,
		log,
		tools: { toLLMTools: () => opts.tools ?? [] },
		runMgr: {
			id: 'run_1' as RunId,
			currentIteration: 3,
			messages: opts.messages,
			lastPromptTokens: opts.lastPromptTokens,
			lastPromptMessageCount: opts.lastPromptMessageCount,
			clearLastPromptTokens: () => {},
			accumulateUsage: () => {},
		},
		emitEvent: async () => {},
	} as unknown as IterationContext

	return { ctx, log }
}

/** ~`tokens` worth of text under the chars/4 ratio. */
const bulk = (tokens: number) => 'x'.repeat(tokens * 4)

describe('the tail appended after the measurement', () => {
	it('counts toward the trigger', async () => {
		// Measured at 1,200 of a 2,500 window — 48%, comfortably under the
		// 70% trigger. The turn then appended ~1,000 tokens of tool output,
		// putting the real context at ~88%. Reading the measurement verbatim
		// meant not compacting on the turn that grew the context the most.
		const measured: Message[] = [
			createSystemMessage('system'),
			createUserMessage('go'),
			createAssistantMessage('working'),
		]
		const messages = [...measured, createAssistantMessage(bulk(1_000))]

		const { ctx, log } = makeCtx({
			messages,
			lastPromptTokens: 1_200,
			lastPromptMessageCount: measured.length,
		})
		await runCompactionCheck(ctx)

		const entry = compactionLog(log)
		expect(entry).toBeDefined()
		expect(entry?.measuredBy).toBe('provider')
		// The measurement is kept whole and the tail added to it — not
		// re-estimated from scratch, which would throw away the one real
		// number available.
		expect(entry?.contextTokens).toBeGreaterThanOrEqual(2_200)
	})

	it('leaves the measurement alone when nothing was appended', async () => {
		const messages: Message[] = [createUserMessage('go'), createAssistantMessage('done')]
		const { ctx, log } = makeCtx({
			messages,
			lastPromptTokens: 2_000,
			lastPromptMessageCount: messages.length,
		})
		await runCompactionCheck(ctx)

		expect(compactionLog(log)?.contextTokens).toBe(2_000)
	})

	it('falls back to the measurement verbatim when no watermark was recorded', async () => {
		// A resumed run, or a persistence layer that predates the watermark.
		// Adding an unbounded tail there would double-count the whole
		// history, which is a worse error than the staleness.
		const messages: Message[] = [createUserMessage('go'), createAssistantMessage(bulk(5_000))]
		const { ctx, log } = makeCtx({ messages, lastPromptTokens: 2_000 })
		await runCompactionCheck(ctx)

		expect(compactionLog(log)?.contextTokens).toBe(2_000)
	})
})

describe('the tool catalogue', () => {
	it('counts toward the estimate when no provider number exists yet', async () => {
		// Iteration 1: nothing has been measured. The messages are trivial,
		// but the schemas shipped with every request are not.
		const messages: Message[] = [createUserMessage('go')]
		const tools = Array.from({ length: 30 }, (_, i) => ({
			type: 'function',
			function: {
				name: `tool_${i}`,
				description: 'x'.repeat(120),
				parameters: { type: 'object', properties: { arg: { type: 'string' } } },
			},
		}))

		const { ctx, log } = makeCtx({ messages, tools })
		await runCompactionCheck(ctx)

		const entry = compactionLog(log)
		expect(entry?.measuredBy).toBe('estimate')
		expect(entry?.contextTokens).toBeGreaterThan(WINDOW * 0.7)
	})

	it('does not fire on a small catalogue and a small history', async () => {
		// The counterpart: the fix must not make the trigger hair-sensitive.
		const { ctx, log } = makeCtx({
			messages: [createUserMessage('go')],
			tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
		})
		await runCompactionCheck(ctx)

		expect(compactionLog(log)).toBeUndefined()
	})

	it('survives a registry that cannot render its catalogue', async () => {
		// The catalogue sharpens the estimate; it is not a precondition for
		// compacting. Throwing here would take down a run for a reason the
		// model call reports far better.
		const { ctx, log } = makeCtx({ messages: [createUserMessage(bulk(2_000))] })
		;(ctx as { tools: unknown }).tools = {
			toLLMTools: () => {
				throw new Error('registry unavailable')
			},
		}

		await expect(runCompactionCheck(ctx)).resolves.toBeUndefined()
		expect(compactionLog(log)).toBeDefined()
	})
})
