import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import {
	STRUCTURED_OUTPUT_TOOL_NAME,
	createStructuredOutputTool,
} from '../../../tools/builtins/structuredOutput.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { StructuredOutputConfig } from '../../../types/structured-output/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { CheckpointManager } from '../checkpoint.js'
import { ToolExecutor } from '../executor.js'
import type { GuardCoordinator } from '../guard.js'
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

	/** Every tool that actually reached `execute`, in order — the side effects. */
	const executedTools: string[] = []

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
			executedTools.push(name)
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
		runConfig: { model: 'mock', maxIterations, timeoutMs: 30_000, tokenBudget: 100_000 },
		tools,
		runMgr: runMgr as unknown as RunPersistence,
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
		checkpointMgr: {
			create: async () => ({ id: 'cp_1' }) as unknown as IterationCheckpoint,
		} as unknown as CheckpointManager,
		resumeHandler: async () => ({ action: 'approve_tools' }),
		planManager: { active: null } as unknown as PlanManager,
		guard: {
			beforeIteration: () => ({
				shouldStop: iteration >= maxIterations,
				forceFinalize: false,
				isCancelled: false,
				stopReason: 'max_iterations',
			}),
		} as unknown as GuardCoordinator,
		...(opts.structuredOutput ? { structuredOutput: opts.structuredOutput } : {}),
	})

	return {
		orchestrator,
		messages,
		executedTools,
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
	 * `terminalToolOutput` refuses to settle when a terminal call shared its
	 * turn, because "a model that asked for other work meant to see those
	 * results". `captureStructuredOutput` had no such guard, and the batch
	 * executes BEFORE either is consulted — so a shared turn ran the other
	 * tools, side effects and all, and then ended the run before any model
	 * turn could read what came back.
	 */
	describe('when it shared its turn with other calls', () => {
		it('hands the batch to the model instead of settling on top of it', async () => {
			const provider = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ name: 'inspect_build' },
							{
								name: STRUCTURED_OUTPUT_TOOL_NAME,
								// Attached in the same breath as the request, so it
								// cannot have been informed by the answer.
								args: { verdict: 'pass', notes: 'guessed before looking' },
							},
						],
					},
					{
						toolCalls: [
							{
								name: STRUCTURED_OUTPUT_TOOL_NAME,
								args: { verdict: 'fail', notes: 'inspect_build came back' },
							},
						],
					},
				],
			})
			const h = harness({ provider, structuredOutput: { schema: SCHEMA } })

			await drain(h.orchestrator)

			// The premise, and the reason this is worse than a discarded
			// answer: the other tool ALREADY ran. Its side effects happened.
			expect(h.executedTools).toContain('inspect_build')

			// The defect: nothing consumed them. They now ride out in the very
			// next request to the model, which is the only thing that makes
			// having run them worth anything.
			const secondRequest = provider.requests[1]
			expect(secondRequest, 'the run settled instead of taking another turn').toBeDefined()
			const relayed = (secondRequest?.messages ?? []).filter((m) => m.role === 'tool')
			expect(JSON.stringify(relayed)).toContain('inspect_build ok')

			// And the answer the caller receives is the one formed after that
			// result, not the one the model attached before asking for it.
			expect(h.structured()).toEqual({ verdict: 'fail', notes: 'inspect_build came back' })
			expect(h.stopReason()).toBe('end_turn')
			expect(h.iterations()).toBe(2)
		})

		it('does not spend a schema retry on a turn that produced a valid answer', async () => {
			// `maxRetries: 1` allows one re-prompt. Charging these relays to
			// that budget would kill the run on the second one, reported as
			// `structured_output_failed` — a schema failure that did not
			// happen, on a model that is visibly making progress.
			const provider = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ name: 'read_a' },
							{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'pass', notes: 'after a' } },
						],
					},
					{
						toolCalls: [
							{ name: 'read_b' },
							{ name: STRUCTURED_OUTPUT_TOOL_NAME, args: { verdict: 'pass', notes: 'after b' } },
						],
					},
					{
						toolCalls: [
							{
								name: STRUCTURED_OUTPUT_TOOL_NAME,
								args: { verdict: 'pass', notes: 'alone at last' },
							},
						],
					},
				],
			})
			const h = harness({
				provider,
				structuredOutput: { schema: SCHEMA, maxRetries: 1 },
				maxIterations: 10,
			})

			await drain(h.orchestrator)

			expect(h.executedTools).toEqual(expect.arrayContaining(['read_a', 'read_b']))
			expect(h.stopReason()).toBe('end_turn')
			expect(h.structured()).toEqual({ verdict: 'pass', notes: 'alone at last' })
		})

		it('is bounded by maxIterations when the model never stops pairing', async () => {
			// The pathology the paragraph above accepts, pinned: a model that
			// pairs forever ends on the iteration ceiling rather than looping,
			// hanging, or settling on an under-informed answer. This is the
			// same bound `terminalToolOutput` relies on for its own relay.
			const provider = new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{ name: 'again' },
							{
								name: STRUCTURED_OUTPUT_TOOL_NAME,
								args: { verdict: 'pass', notes: 'never alone' },
							},
						],
					},
				],
			})
			const h = harness({ provider, structuredOutput: { schema: SCHEMA }, maxIterations: 4 })

			await drain(h.orchestrator)

			expect(h.iterations()).toBeLessThanOrEqual(5)
			expect(h.structured()).toBeUndefined()
			expect(h.stopReason()).toBe('max_iterations')
		})
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
