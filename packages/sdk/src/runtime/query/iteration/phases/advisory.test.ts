/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 6 follow-up):
 *
 *   This file pins the live mutation boundary that `src/advisory/*` tests
 *   intentionally do NOT cover: the advisory phase IS where advisories
 *   inject user messages into the run via `ctx.runMgr.pushMessage(...)`
 *   (Codex #6). A regression that drops the `pushMessage` call — silently
 *   dropping all advisor output — would pass `src/advisory` tests,
 *   typecheck, and lint. This file is the only thing that catches it.
 *
 *   - **Early-return paths** (no side effects):
 *     - No `advisoryCtx` on the iteration ctx → returns immediately.
 *     - `advisoryCtx.checkBudget()` denies → returns; NO pushMessage.
 *     - Evaluator fires no triggers → returns; NO pushMessage.
 *     - Trigger fires but advisor not found in registry → warn log +
 *       return; NO pushMessage.
 *     - Executor throws → warn log + return; NO pushMessage (partial
 *       work NOT persisted).
 *   - **Happy path** — trigger fires + advisor resolves + executor
 *     succeeds:
 *     - Calls `executor.consult(advisor, request, callCtx)` exactly once.
 *     - Calls `evaluator.recordFiring(trigger.id, iteration)`.
 *     - Calls `advisoryCtx.recordCall(...)` with the full call record.
 *     - Calls `runMgr.pushMessage(createUserMessage(wrapped))` exactly
 *       once.
 *     - The wrapped message includes `<advisory-result advisor="..."
 *       trigger="...">` + the advice text + closing tag.
 *     - When the result carries `warnings`, they appear under a
 *       "Warnings:" section.
 *     - When the result carries `decisions`, they appear under a
 *       "Decisions:" section AND each decision is pushed to
 *       `workingStateManager.addDecision` (if a workingStateManager is
 *       present on ctx).
 *   - **Trigger selection**: only the first trigger from
 *     `evaluator.evaluate(state)[0]` is used per iteration; other fired
 *     triggers are discarded this round.
 *   - **Question resolution**: `trigger.questionTemplate` is used when
 *     set; otherwise the phase uses a default
 *     "Iteration N: Review the current progress..." string.
 */

import { describe, expect, it, vi } from 'vitest'

import type { AdvisoryContext } from '../../../../advisory/context.js'
import type {
	AdvisorDefinition,
	AdvisoryResult,
	AdvisoryTrigger,
} from '../../../../types/advisory/index.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { Logger } from '../../../../utils/logger.js'

import { runAdvisoryPhase } from './advisory.js'
import type { IterationContext } from './context.js'

function makeLogger(): Logger {
	const self = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: vi.fn(),
	} as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

interface MockAdvisoryCtxOptions {
	budgetAllowed?: boolean
	firedTriggers?: AdvisoryTrigger[]
	advisor?: AdvisorDefinition
	consultResult?: AdvisoryResult
	consultThrows?: Error
}

function makeAdvisoryCtx(options: MockAdvisoryCtxOptions = {}) {
	const {
		budgetAllowed = true,
		firedTriggers = [],
		advisor,
		consultResult = { advice: 'do the thing' },
		consultThrows,
	} = options

	const consult = vi.fn(async () => {
		if (consultThrows) throw consultThrows
		return {
			result: consultResult,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
			durationMs: 1,
		}
	})
	const evaluate = vi.fn(() => firedTriggers)
	const recordFiring = vi.fn()
	const resolve = vi.fn(() => advisor)
	const checkBudget = vi.fn(() => ({
		allowed: budgetAllowed,
		reason: budgetAllowed ? undefined : 'exhausted',
	}))
	const recordCall = vi.fn()

	return {
		ctx: {
			registry: { resolve },
			executor: { consult },
			evaluator: { evaluate, recordFiring },
			checkBudget,
			recordCall,
			callHistory: [],
		} as unknown as AdvisoryContext,
		mocks: { consult, evaluate, recordFiring, resolve, checkBudget, recordCall },
	}
}

interface MockCtxOptions {
	advisoryCtx?: AdvisoryContext
	withWorkingState?: boolean
}

function makeCtx(options: MockCtxOptions = {}): {
	ctx: IterationContext
	pushMessage: ReturnType<typeof vi.fn>
	addDecision: ReturnType<typeof vi.fn>
} {
	const pushMessage = vi.fn()
	const addDecision = vi.fn()

	const ctx = {
		advisoryCtx: options.advisoryCtx,
		runConfig: { tokenBudget: 100_000, costLimitUsd: undefined },
		tools: {
			get: vi.fn(() => undefined),
			toLLMTools: vi.fn(() => []),
		},
		runMgr: {
			id: 'run_1' as RunId,
			messages: [],
			tokenUsage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			costInfo: {
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 0,
				cacheDiscount: 0,
			},
			pushMessage,
		},
		log: makeLogger(),
		workingStateManager: options.withWorkingState
			? {
					getState: vi.fn(() => ({
						task: '',
						plan: [],
						files: new Map(),
						decisions: [],
						failures: [],
						discoveries: [],
						environment: [],
						toolResults: [],
						userRequirements: [],
						assistantNotes: [],
					})),
					addDecision,
				}
			: undefined,
	} as unknown as IterationContext

	return { ctx, pushMessage, addDecision }
}

const response = {
	id: 'r',
	model: 'm',
	message: { role: 'assistant' as const, content: 'text' },
	usage: {
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	},
	finishReason: 'stop' as const,
}

const advisor: AdvisorDefinition = {
	id: 'adv',
	name: 'Advisor',
	provider: {} as never,
	model: 'opus',
}

const trigger: AdvisoryTrigger = {
	id: 'trig',
	condition: { type: 'on_iteration', everyN: 1 },
	advisorId: 'adv',
}

describe('runAdvisoryPhase — early-return paths (no pushMessage)', () => {
	it('returns immediately when advisoryCtx is absent', async () => {
		const { ctx, pushMessage } = makeCtx()
		await runAdvisoryPhase(ctx, 1, response)
		expect(pushMessage).not.toHaveBeenCalled()
	})

	it('returns when budget is denied', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({ budgetAllowed: false })
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })
		await runAdvisoryPhase(ctx, 1, response)
		expect(mocks.checkBudget).toHaveBeenCalled()
		expect(mocks.evaluate).not.toHaveBeenCalled()
		expect(pushMessage).not.toHaveBeenCalled()
	})

	it('returns when evaluator fires no triggers', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({ firedTriggers: [] })
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })
		await runAdvisoryPhase(ctx, 1, response)
		expect(mocks.evaluate).toHaveBeenCalled()
		expect(mocks.resolve).not.toHaveBeenCalled()
		expect(pushMessage).not.toHaveBeenCalled()
	})

	it('returns (warn) when trigger fires but advisor is not resolved', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor: undefined,
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })
		await runAdvisoryPhase(ctx, 1, response)
		expect(mocks.resolve).toHaveBeenCalledWith('adv')
		expect(mocks.consult).not.toHaveBeenCalled()
		expect(pushMessage).not.toHaveBeenCalled()
	})

	it('returns when executor.consult throws — does NOT pushMessage partial work', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultThrows: new Error('provider timeout'),
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })
		await runAdvisoryPhase(ctx, 1, response)
		expect(mocks.consult).toHaveBeenCalled()
		expect(mocks.recordFiring).not.toHaveBeenCalled()
		expect(mocks.recordCall).not.toHaveBeenCalled()
		expect(pushMessage).not.toHaveBeenCalled()
	})
})

describe('runAdvisoryPhase — happy path', () => {
	it('calls executor + recordFiring + recordCall + pushMessage exactly once', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultResult: { advice: 'do the thing' },
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 3, response)

		expect(mocks.consult).toHaveBeenCalledTimes(1)
		expect(mocks.recordFiring).toHaveBeenCalledWith('trig', 3)
		expect(mocks.recordCall).toHaveBeenCalledTimes(1)
		expect(pushMessage).toHaveBeenCalledTimes(1)
	})

	it('pushMessage wraps advice in <advisory-result> envelope with role user', async () => {
		const { ctx: advCtx } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultResult: { advice: 'specific advice text' },
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 1, response)

		const pushed = pushMessage.mock.calls[0]?.[0] as { role: string; content: string }
		expect(pushed.role).toBe('user')
		expect(pushed.content).toContain('<advisory-result advisor="Advisor" trigger="trig">')
		expect(pushed.content).toContain('specific advice text')
		expect(pushed.content).toContain('</advisory-result>')
	})

	it('includes Warnings section when the result carries warnings', async () => {
		const { ctx: advCtx } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultResult: {
				advice: 'proceed',
				warnings: ['slow response', 'retry likely'],
			},
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 1, response)

		const pushed = pushMessage.mock.calls[0]?.[0] as { content: string }
		expect(pushed.content).toContain('Warnings:')
		expect(pushed.content).toContain('- slow response')
		expect(pushed.content).toContain('- retry likely')
	})

	it('includes Decisions section + pushes each decision to workingStateManager', async () => {
		const { ctx: advCtx } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultResult: {
				advice: 'go',
				decisions: ['use sqlite', 'skip migration'],
			},
		})
		const { ctx, pushMessage, addDecision } = makeCtx({
			advisoryCtx: advCtx,
			withWorkingState: true,
		})

		await runAdvisoryPhase(ctx, 1, response)

		const pushed = pushMessage.mock.calls[0]?.[0] as { content: string }
		expect(pushed.content).toContain('Decisions:')
		expect(pushed.content).toContain('- use sqlite')
		expect(pushed.content).toContain('- skip migration')

		expect(addDecision).toHaveBeenCalledTimes(2)
		expect(addDecision).toHaveBeenCalledWith('use sqlite')
		expect(addDecision).toHaveBeenCalledWith('skip migration')
	})

	it('does NOT attempt to addDecision when no workingStateManager is present', async () => {
		const { ctx: advCtx } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
			consultResult: {
				advice: 'go',
				decisions: ['a'],
			},
		})
		const { ctx, pushMessage } = makeCtx({ advisoryCtx: advCtx, withWorkingState: false })

		await runAdvisoryPhase(ctx, 1, response)
		// pushMessage still carries the Decisions section in content
		expect((pushMessage.mock.calls[0]?.[0] as { content: string }).content).toContain('- a')
	})
})

describe('runAdvisoryPhase — trigger selection + question', () => {
	it('uses only the first fired trigger per iteration', async () => {
		const other: AdvisoryTrigger = {
			id: 'other',
			condition: { type: 'on_iteration', everyN: 1 },
			advisorId: 'adv',
		}
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [trigger, other],
			advisor,
		})
		const { ctx } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 1, response)

		expect(mocks.recordFiring).toHaveBeenCalledTimes(1)
		expect(mocks.recordFiring).toHaveBeenCalledWith('trig', 1)
	})

	it('uses trigger.questionTemplate when present', async () => {
		const custom: AdvisoryTrigger = {
			...trigger,
			questionTemplate: 'Custom question',
		}
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [custom],
			advisor,
		})
		const { ctx } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 7, response)
		const consultArgs = mocks.consult.mock.calls[0] as unknown as [
			unknown,
			{ question: string },
			unknown,
		]
		expect(consultArgs?.[1].question).toBe('Custom question')
	})

	it('falls back to the default "Iteration N: ..." question when no template', async () => {
		const { ctx: advCtx, mocks } = makeAdvisoryCtx({
			firedTriggers: [trigger],
			advisor,
		})
		const { ctx } = makeCtx({ advisoryCtx: advCtx })

		await runAdvisoryPhase(ctx, 7, response)
		const consultArgs = mocks.consult.mock.calls[0] as unknown as [
			unknown,
			{ question: string },
			unknown,
		]
		expect(consultArgs?.[1].question).toContain('Iteration 7')
	})
})
