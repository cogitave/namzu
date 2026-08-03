import { describe, expect, it, vi } from 'vitest'

import { MockLLMProvider } from '../../provider/mock.js'
import { ToolExecutor } from '../../runtime/query/executor.js'
import { IterationOrchestrator } from '../../runtime/query/iteration/index.js'
import { ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { Message } from '../../types/message/index.js'
import type { Run } from '../../types/run/entity.js'
import type { RunEvent } from '../../types/run/index.js'
import { hasToolCall } from '../../types/run/step.js'
import type { ToolRegistryContract } from '../../types/tool/index.js'
import type { Logger } from '../../utils/logger.js'
import { runExperiment } from '../experiment.js'
import { evalRunFromRun } from '../from-run.js'
import { completionScorer, trajectoryScorer } from '../scorers.js'
import type { EvalCase } from '../types.js'

/**
 * The harness against the REAL loop, driven by the scriptable mock.
 *
 * The unit tests above check the scorers in isolation; this checks the
 * thing that actually matters — that a behavior change in the agent shows
 * up as a score drop. Every piece this depends on had to land first:
 * `Run.steps` (otherwise a trajectory scorer would correlate raw events by
 * iteration number) and a mock that can emit tool calls (otherwise the
 * loop cannot be driven at all).
 */

const RUN_ID = 'run_eval' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/** Drive the loop with a scripted model and return the finished `Run`. */
async function driveAgent(turns: unknown[]): Promise<Run> {
	const messages: Message[] = []
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
		execute: vi.fn(async (name: string) => ({ success: true, output: `${name} ok` })),
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
		costInfo: { inputCostPer1M: 0, outputCostPer1M: 0, totalCost: 0, cacheDiscount: 0 },
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
		setStructuredOutput: vi.fn(),
		markCancelled: vi.fn(),
	}

	const orchestrator = new IterationOrchestrator({
		provider: new MockLLMProvider({ turns: turns as never }),
		runConfig: { model: 'mock', maxIterations: 10 },
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
		planManager: { active: undefined },
		resumeHandler: async () => ({ action: 'approve_tools' }),
		stopWhen: hasToolCall('finish'),
		guard: {
			beforeIteration: () => ({
				shouldStop: iteration >= 10,
				forceFinalize: false,
				isCancelled: false,
				stopReason: 'max_iterations',
			}),
		},
	} as never)

	const gen = orchestrator.runLoop()
	let next = await gen.next()
	while (!next.done) next = await gen.next()

	return {
		id: RUN_ID,
		status: 'completed',
		messages,
		tokenUsage: runMgr.tokenUsage,
		costInfo: runMgr.costInfo,
		currentIteration: iteration,
		startedAt: Date.now() - 10,
		endedAt: Date.now(),
		steps: orchestrator.getSteps(),
		...(stopReason ? { stopReason } : {}),
		result: 'done',
	} as unknown as Run
}

/** The trajectory a healthy agent takes for this task. */
const GOLDEN: EvalCase[] = [
	{
		name: 'reads before editing, then finishes',
		input: 'edit the file',
		expectedTools: ['read', 'edit', 'finish'],
	},
]

const HEALTHY = [
	{ toolCalls: [{ name: 'read' }] },
	{ toolCalls: [{ name: 'edit' }] },
	{ toolCalls: [{ name: 'finish' }] },
]

describe('the harness scores a real run', () => {
	it('projects a finished Run into the shape scorers consume', async () => {
		const run = await driveAgent(HEALTHY)
		const projected = evalRunFromRun(run)

		expect(projected.toolCalls).toEqual(['read', 'edit', 'finish'])
		expect(projected.steps).toHaveLength(3)
		expect(projected.stopReason).toBe('stop_condition')
	})

	it('scores the golden trajectory 1', async () => {
		const report = await runExperiment({
			name: 'file-editing',
			cases: GOLDEN,
			scorers: [trajectoryScorer(), completionScorer(['stop_condition'])],
			run: async () => evalRunFromRun(await driveAgent(HEALTHY)),
		})

		expect(report.mean).toBe(1)
		expect(report.failed).toBe(0)
	})
})

describe('the harness catches a behavior regression', () => {
	it('drops the score when the agent skips a step', async () => {
		// The regression this is for: a tool-description change that makes the
		// agent edit without reading first. Final-answer scoring cannot see
		// it — the file still gets edited.
		const regressed = [{ toolCalls: [{ name: 'edit' }] }, { toolCalls: [{ name: 'finish' }] }]

		const report = await runExperiment({
			name: 'file-editing',
			cases: GOLDEN,
			scorers: [trajectoryScorer()],
			run: async () => evalRunFromRun(await driveAgent(regressed)),
		})

		expect(report.mean).toBeLessThan(1)
		expect(report.failed).toBe(1)
		expect(report.cases[0]?.scores.trajectory?.reason).toContain('read')
	})

	it('drops the score when the agent becomes wasteful', async () => {
		// The regression this is for: a `search_tools` top-k change that makes
		// the agent probe before acting. The answer is identical; the bill is
		// not.
		const wasteful = [
			{ toolCalls: [{ name: 'ls' }] },
			{ toolCalls: [{ name: 'glob' }] },
			{ toolCalls: [{ name: 'read' }] },
			{ toolCalls: [{ name: 'edit' }] },
			{ toolCalls: [{ name: 'finish' }] },
		]

		const report = await runExperiment({
			name: 'file-editing',
			cases: GOLDEN,
			scorers: [trajectoryScorer()],
			run: async () => evalRunFromRun(await driveAgent(wasteful)),
		})

		expect(report.mean).toBeLessThan(1)
		// Recall is intact — it did everything asked. Precision is what fell.
		expect(report.cases[0]?.scores.trajectory?.details?.recall).toBe(1)
		expect(report.cases[0]?.scores.trajectory?.details?.precision).toBeLessThan(1)
	})

	it('separates the two failures, which a pass/fail assertion would not', async () => {
		const score = async (turns: unknown[]) => {
			const report = await runExperiment({
				name: 'x',
				cases: GOLDEN,
				scorers: [trajectoryScorer()],
				run: async () => evalRunFromRun(await driveAgent(turns)),
			})
			return report.mean
		}

		const skipped = await score([
			{ toolCalls: [{ name: 'edit' }] },
			{ toolCalls: [{ name: 'finish' }] },
		])
		const wasteful = await score([
			{ toolCalls: [{ name: 'ls' }] },
			{ toolCalls: [{ name: 'read' }] },
			{ toolCalls: [{ name: 'edit' }] },
			{ toolCalls: [{ name: 'finish' }] },
		])

		expect(skipped).not.toBe(wasteful)
		// Skipping required work is worse than doing it inefficiently.
		expect(skipped).toBeLessThan(wasteful)
	})
})
