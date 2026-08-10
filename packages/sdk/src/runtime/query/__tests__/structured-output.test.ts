import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import {
	STRUCTURED_OUTPUT_TOOL_NAME,
	createStructuredOutputTool,
} from '../../../tools/builtins/structuredOutput.js'
import type { RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { StructuredOutputConfig } from '../../../types/structured-output/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'
import { IterationOrchestrator } from '../iteration/index.js'

/**
 * Both leaf pieces shipped and neither was reachable.
 * `createStructuredOutputTool` is excluded from `getBuiltinTools()`, and
 * `StructuredOutputConfig` was referenced by exactly one non-test line —
 * the barrel re-export. A host needing `{verdict, findings}` from an agent
 * that also uses tools had to register the tool by hand and hope: nothing
 * forced the call, nothing stopped the loop when it came, and a schema
 * mismatch surfaced as a ZodError AFTER the run had paid for itself.
 */

const RUN_ID = 'run_so' as RunId

const SCHEMA = z.object({
	verdict: z.enum(['pass', 'fail']),
	notes: z.string(),
})

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function harness(opts: {
	provider: LLMProvider
	structuredOutput?: StructuredOutputConfig
	maxIterations?: number
}) {
	const messages: Message[] = []
	let iteration = 0
	let stopReason: string | undefined
	let structured: unknown
	const log = makeLogger()

	const outputTool = createStructuredOutputTool(SCHEMA)
	const registry = new Map<string, unknown>([[STRUCTURED_OUTPUT_TOOL_NAME, outputTool]])

	const tools = {
		get: vi.fn(
			(name: string) =>
				registry.get(name) ?? {
					name,
					isConcurrencySafe: () => true,
					isReadOnly: () => true,
					isDestructive: () => false,
				},
		),
		execute: vi.fn(async (name: string, input: unknown) => {
			if (name === STRUCTURED_OUTPUT_TOOL_NAME) {
				const parsed = SCHEMA.safeParse(input)
				if (!parsed.success) {
					return { success: false, output: '', error: parsed.error.message }
				}
				return { success: true, output: JSON.stringify(parsed.data), data: parsed.data }
			}
			return { success: true, output: `${name} ok` }
		}),
		has: vi.fn((name: string) => registry.has(name)),
		listNames: vi.fn(() => [...registry.keys()]),
		getAvailability: vi.fn(() => 'active'),
		toLLMTools: vi.fn(() => []),
		register: vi.fn(),
		unregister: vi.fn(),
	} as unknown as ToolRegistryContract

	const activityStore = new ActivityStore(RUN_ID, {
		enabled: false,
		trackToolCalls: false,
		trackLlmTurns: false,
	})

	const maxIterations = opts.maxIterations ?? 8

	const runMgr = {
		id: RUN_ID,
		messages,
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
			unpricedTokens: 0,
		},
		get currentIteration() {
			return iteration
		},
		incrementIteration: () => ++iteration,
		pushMessage: (m: Message) => {
			messages.push(m)
		},
		recordTurnUsage: vi.fn(),
		accumulateUsage: vi.fn(),
		clearLastPromptTokens: vi.fn(),
		lastPromptTokens: undefined,
		setStopReason: (r: string) => {
			stopReason = r
		},
		setStructuredOutput: (v: unknown) => {
			structured = v
		},
		markCancelled: vi.fn(),
	}

	const orchestrator = new IterationOrchestrator({
		provider: opts.provider,
		runConfig: { model: 'mock', maxIterations },
		tools,
		runMgr,
		toolExecutor: new ToolExecutor(
			{
				tools,
				runId: RUN_ID,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			activityStore,
			async () => {},
			log,
		),
		activityStore,
		abortController: new AbortController(),
		log,
		emitEvent: async () => {},
		drainPending: function* (): Generator<RunEvent> {},
		checkpointMgr: { create: async () => ({ id: 'cp_1' }) },
		resumeHandler: async () => ({ action: 'approve_tools' }),
		planManager: { active: undefined },
		guard: {
			beforeIteration: () => ({
				shouldStop: iteration >= maxIterations,
				forceFinalize: false,
				isCancelled: false,
				stopReason: 'max_iterations',
			}),
		},
		...(opts.structuredOutput ? { structuredOutput: opts.structuredOutput } : {}),
	} as never)

	return {
		orchestrator,
		messages,
		stopReason: () => stopReason,
		structured: () => structured,
		iterations: () => iteration,
	}
}

async function drain(o: IterationOrchestrator) {
	const gen = o.runLoop()
	let next = await gen.next()
	while (!next.done) next = await gen.next()
}

describe('structured final output', () => {
	it('lands the validated value on the run and ends there', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'read' }] },
				{
					toolCalls: [
						{
							name: STRUCTURED_OUTPUT_TOOL_NAME,
							args: { verdict: 'pass', notes: 'looks fine' },
						},
					],
				},
				// Would keep going if the run did not end on the output.
				{ text: 'should never be reached' },
			],
		})
		const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

		await drain(h.orchestrator)

		expect(h.structured()).toEqual({ verdict: 'pass', notes: 'looks fine' })
		expect(h.stopReason()).toBe('end_turn')
		expect(h.iterations()).toBe(2)
	})

	it('re-prompts when the model answers in prose instead', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ text: 'The verdict is pass.' },
				{
					toolCalls: [
						{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'pass', notes: 'ok' } },
					],
				},
			],
		})
		const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

		await drain(h.orchestrator)

		// The re-prompt reached the model...
		expect(h.messages.some((m) => String(m.content).includes('structured_output'))).toBe(true)
		// ...and the second turn satisfied it.
		expect(h.structured()).toEqual({ verdict: 'pass', notes: 'ok' })
		expect(h.stopReason()).toBe('end_turn')
	})

	it('gives up loudly rather than looping when the model never complies', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'still prose' }] })
		const h = harness({
			provider,
			structuredOutput: { schema: SCHEMA, maxRetries: 2 },
			maxIterations: 20,
		})

		await drain(h.orchestrator)

		expect(h.stopReason()).toBe('structured_output_failed')
		expect(h.structured()).toBeUndefined()
		// Bounded by maxRetries, nowhere near maxIterations.
		expect(h.iterations()).toBeLessThanOrEqual(4)
	})

	it('a schema-invalid call does not satisfy the demand', async () => {
		const provider = new MockLLMProvider({
			turns: [
				// `verdict` is not in the enum → the tool returns an error result.
				{ toolCalls: [{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'maybe' } }] },
				{
					toolCalls: [
						{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'fail', notes: 'second try' } },
					],
				},
			],
		})
		const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

		await drain(h.orchestrator)

		expect(h.structured()).toEqual({ verdict: 'fail', notes: 'second try' })
	})

	/**
	 * The answer is not final while the model is still waiting to hear back.
	 *
	 * A terminal tool that shares its turn relays instead of settling
	 * (`terminalToolOutput`), on the reasoning that the model asked for the
	 * other work and should see it. The output tool had no such guard, so a
	 * turn holding the answer AND a question ended the run: the other tools
	 * ran, their results went nowhere, and the accepted answer was the one
	 * the model composed BEFORE reading them.
	 */
	it('does not settle when the output call shares its turn with other work', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'pass', notes: 'guessed' } },
						{ name: 'read' },
					],
				},
				{
					toolCalls: [
						{
							name: STRUCTURED_OUTPUT_TOOL_NAME,
							args: { verdict: 'fail', notes: 'after reading' },
						},
					],
				},
			],
		})
		const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

		await drain(h.orchestrator)

		// The answer formed AFTER the read, not the one composed beside it.
		expect(h.structured()).toEqual({ verdict: 'fail', notes: 'after reading' })
		expect(h.stopReason()).toBe('end_turn')
		// A second model turn was actually paid for — which is what "the model
		// saw the result" means. Asserting only that `read ok` is in the
		// transcript proves nothing: the batch runs before the capture, so the
		// result is in the message log either way. That assertion passes on the
		// unfixed code, and a check that cannot fail is worse than none.
		expect(h.iterations()).toBe(2)
		expect(h.messages.some((m) => JSON.stringify(m.content).includes('read ok'))).toBe(true)
	})

	it('still settles a lone output call that arrives with nothing else', async () => {
		// The guard must not cost the ordinary case a turn.
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'pass', notes: 'alone' } },
					],
				},
				{ text: 'should never be reached' },
			],
		})
		const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

		await drain(h.orchestrator)

		expect(h.structured()).toEqual({ verdict: 'pass', notes: 'alone' })
		expect(h.iterations()).toBe(1)
	})

	it('is inert when no structured output was requested', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'plain answer' }] })
		const h = harness({ provider })

		await drain(h.orchestrator)

		expect(h.structured()).toBeUndefined()
		expect(h.stopReason()).toBe('end_turn')
		expect(h.iterations()).toBe(1)
	})
})
