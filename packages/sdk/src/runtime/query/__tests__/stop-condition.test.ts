import { describe, expect, it, vi } from 'vitest'

import type { PlanManager } from '../../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../../manager/run/persistence.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type { LLMProvider } from '../../../types/provider/index.js'
import type { RunEvent, StepResult } from '../../../types/run/index.js'
import { hasToolCall, stepCountIs } from '../../../types/run/step.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { CheckpointManager } from '../checkpoint.js'
import { ToolExecutor } from '../executor.js'
import type { GuardCoordinator } from '../guard.js'
import { IterationOrchestrator } from '../iteration/index.js'

/**
 * End-to-end for the loop's new halt seam, driven through the scriptable
 * mock provider — which is exactly what that provider was rebuilt for.
 *
 * Before this the only halt was `GuardCoordinator`: four numeric budgets,
 * never the messages. A terminal `submit_answer` tool could not end a run,
 * so a finished task kept iterating until `maxIterations: 200` or the token
 * budget stopped it, burning the whole envelope after the work was done.
 */

const RUN_ID = 'run_stop' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

interface Harness {
	orchestrator: IterationOrchestrator
	executedTools: string[]
	messages: Message[]
	stopReason: () => string | undefined
	steps: StepResult[]
}

function harness(opts: {
	provider: LLMProvider
	stopWhen?: Parameters<typeof buildCtx>[0]['stopWhen']
	maxIterations?: number
}): Harness {
	return buildCtx(opts)
}

function buildCtx(opts: {
	provider: LLMProvider
	stopWhen?: import('../../../types/run/step.js').StopCondition
	maxIterations?: number
}): Harness {
	const executedTools: string[] = []
	const messages: Message[] = []
	const steps: StepResult[] = []
	let iteration = 0
	let stopReason: string | undefined
	const log = makeLogger()

	const tools = {
		get: vi.fn((name: string) => ({
			name,
			isConcurrencySafe: () => true,
			isReadOnly: () => true,
			isDestructive: () => false,
		})),
		execute: vi.fn(async (name: string) => {
			executedTools.push(name)
			return { success: true, output: `${name} done` }
		}),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
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

	const toolExecutor = new ToolExecutor(
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
	)

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
		markCancelled: vi.fn(),
	}

	const maxIterations = opts.maxIterations ?? 10

	const orchestrator = new IterationOrchestrator({
		provider: opts.provider,
		runConfig: { model: 'mock', maxIterations, timeoutMs: 30_000, tokenBudget: 100_000 },
		tools,
		runMgr: runMgr as unknown as RunPersistence,
		toolExecutor,
		activityStore,
		abortController: new AbortController(),
		log,
		emitEvent: async () => {},
		drainPending: function* (): Generator<RunEvent> {},
		checkpointMgr: {
			create: async () => ({ id: 'cp_1' }) as unknown as IterationCheckpoint,
		} as unknown as CheckpointManager,
		resumeHandler: async () => ({ action: 'approve_tools' }),
		// No plan gate in these cases; the loop consults it before iterating.
		planManager: { active: null } as unknown as PlanManager,
		// A simple iteration cap, so a missing stop condition surfaces as the
		// cap rather than an infinite loop.
		guard: {
			beforeIteration: () => ({
				shouldStop: iteration >= maxIterations,
				forceFinalize: false,
				isCancelled: false,
				stopReason: 'max_iterations',
			}),
		} as unknown as GuardCoordinator,
		...(opts.stopWhen ? { stopWhen: opts.stopWhen } : {}),
		onStepFinish: (s: StepResult) => steps.push(s),
	})

	return { orchestrator, executedTools, messages, steps, stopReason: () => stopReason }
}

async function drain(h: Harness) {
	const gen = h.orchestrator.runLoop()
	let next = await gen.next()
	while (!next.done) next = await gen.next()
}

describe('stopWhen ends the loop', () => {
	it('a terminal tool ends the run — and its result is still recorded', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ name: 'read' }] },
				{ toolCalls: [{ name: 'submit_answer' }] },
				// Would keep going forever without the stop condition.
				{ toolCalls: [{ name: 'read' }] },
			],
		})
		const h = harness({ provider, stopWhen: hasToolCall('submit_answer') })

		await drain(h)

		// The terminal tool RAN — the run ends after it, not instead of it.
		expect(h.executedTools).toEqual(['read', 'submit_answer'])
		expect(h.stopReason()).toBe('stop_condition')
		expect(h.steps).toHaveLength(2)
		expect(h.steps[1]?.toolResults[0]).toMatchObject({
			toolName: 'submit_answer',
			isError: false,
		})
	})

	it('stepCountIs halts at the requested step', async () => {
		const provider = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'read' }] }] })
		const h = harness({ provider, stopWhen: stepCountIs(3) })

		await drain(h)

		expect(h.steps).toHaveLength(3)
		expect(h.stopReason()).toBe('stop_condition')
	})

	it('without a stop condition the loop runs to its iteration cap', async () => {
		const provider = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'read' }] }] })
		const h = harness({ provider, maxIterations: 4 })

		await drain(h)

		expect(h.stopReason()).toBe('max_iterations')
		expect(h.steps.length).toBeGreaterThanOrEqual(4)
	})

	it('a throwing predicate does not kill an otherwise healthy run', async () => {
		const provider = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'read' }] }] })
		const h = harness({
			provider,
			maxIterations: 2,
			stopWhen: () => {
				throw new Error('predicate exploded')
			},
		})

		await drain(h)

		// Failing open leaves the existing budgets in charge.
		expect(h.stopReason()).toBe('max_iterations')
	})
})

describe('step records', () => {
	it('reports per-step tool calls and results in call order', async () => {
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'a' }, { name: 'b' }] }, { toolCalls: [{ name: 'done' }] }],
		})
		const h = harness({ provider, stopWhen: hasToolCall('done') })

		await drain(h)

		expect(h.steps[0]?.toolCalls.map((c) => c.function.name)).toEqual(['a', 'b'])
		expect(h.steps[0]?.toolResults.map((r) => r.toolName)).toEqual(['a', 'b'])
		expect(h.steps[0]?.stepNumber).toBe(1)
		expect(h.steps[0]?.model).toBe('mock')
	})

	it('carries a finish reason and non-negative timings', async () => {
		const provider = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'done' }] }] })
		const h = harness({ provider, stopWhen: hasToolCall('done') })

		await drain(h)

		const step = h.steps[0]
		expect(step?.finishReason).toBe('tool_calls')
		expect(step?.durationMs).toBeGreaterThanOrEqual(0)
		expect(step?.toolExecutionMs).toBeGreaterThanOrEqual(0)
		expect(step?.durationMs).toBeGreaterThanOrEqual(step?.toolExecutionMs ?? 0)
	})

	it('exposes the accumulated steps on the orchestrator', async () => {
		const provider = new MockLLMProvider({ turns: [{ toolCalls: [{ name: 'done' }] }] })
		const h = harness({ provider, stopWhen: hasToolCall('done') })

		await drain(h)

		expect(h.orchestrator.getSteps()).toHaveLength(1)
		expect(h.orchestrator.getSteps()).toEqual(h.steps)
	})
})
