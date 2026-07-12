// Current-code invariants asserted (2026-07-12, ses_017):
//
// A resume continues the SAME logical run, so it continues the same ledger. Until
// this change it did not: `RunContextFactory.build` minted a blank `RunPersistence`,
// `query()` called `init()` (which stamps a zeroed `run.json`) BEFORE reading the
// checkpoint, and the resume branch restored only messages. Every resume therefore
// handed the run a brand-new budget — a run stopped dead at its cost cap could be
// resumed indefinitely, spending a full fresh allowance each time.
//
//   - `tokenBudget`, `costLimitUsd` and `maxIterations` are LIFETIME limits of the
//     logical run, accumulated across resumes. A run that already spent N tokens
//     resumes at N; one already at its cost cap resumes only to hard-stop, with no
//     model call at all; one at `maxIterations - 1` gets exactly one more iteration.
//   - `timeoutMs` measures the run's ACTIVE EXECUTION time — the sum of its
//     executing segments — NOT calendar time since the run was created. A resume
//     does not hand back a fresh full timeout (a checkpoint whose elapsed already
//     exhausts `timeoutMs` hard-stops immediately), and a human who sat on an
//     approval for three days costs the run nothing: thinking time is not the
//     agent's compute time. See `GuardCoordinator.restoreElapsed`.
//   - A checkpoint written AFTER a resume records the run's whole active elapsed,
//     not just the current segment's — otherwise each resume would silently hand
//     back the time the previous ones spent.
//   - `init()` no longer clobbers the restored ledger: the `run.json` on disk after
//     a resume shows the carried-over usage and iteration count, not zeros.
//
// Deliberately NOT asserted, because the code deliberately does not do it: the
// ActivityStore, PlanManager and WorkingStateManager all start empty on resume.
// A checkpoint carries no activity/plan/working-state history to hydrate them from.
// They are observability, not accounting — no limit is metered against them.
//
// These tests drive the real `query()` loop against a fake provider, resuming from a
// checkpoint written to disk through the production `RunDiskStore` write path.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { CostInfo, TokenUsage } from '../../../types/common/index.js'
import type { IterationCheckpoint } from '../../../types/hitl/index.js'
import type {
	CheckpointId,
	ProjectId,
	RunId,
	SessionId,
	TenantId,
	ThreadId,
} from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { AgentRunConfig, Run } from '../../../types/run/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

const RUN_ID = 'run_resume_test' as RunId
const CHECKPOINT_ID = 'cp_resume_test' as CheckpointId
const SESSION_ID = 'ses_test' as SessionId
const THREAD_ID = 'thr_test' as ThreadId
const PROJECT_ID = 'prj_test' as ProjectId
const TENANT_ID = 'tnt_test' as TenantId

/** Every model call bills this. Pricing below makes it cost exactly $0.02. */
const USAGE: TokenUsage = {
	promptTokens: 1_000,
	completionTokens: 1_000,
	totalTokens: 2_000,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const PRICING = { inputCostPer1M: 10, outputCostPer1M: 10 }
const COST_PER_CALL = 0.02 // (1_000 + 1_000) tokens ÷ 1M × $10

interface FakeProvider extends LLMProvider {
	calls: number
}

/**
 * Ends its turn immediately: one iteration per run, then `end_turn`.
 *
 * `onChat` fires INSIDE the loop, before the run finishes. It is the only handle a
 * test has on the state of the world mid-run — which is where `init()`'s write has
 * landed but the terminal `persist()` has not yet rewritten over it.
 */
function stoppingProvider(onChat?: () => void): FakeProvider {
	const provider: FakeProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			provider.calls += 1
			onChat?.()
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

/**
 * Never ends its turn: every response asks for a tool. The only thing that can
 * stop a run driven by this provider is a guard limit — which is exactly what the
 * iteration-count and timeout tests need to observe.
 *
 * The assistant content is non-empty on purpose: `requestFinalResponse` short-
 * circuits when the last assistant message already has content, so the guard's
 * hard stop costs zero extra model calls and `provider.calls` counts iterations
 * and nothing else.
 */
function loopingProvider(): FakeProvider {
	const provider: FakeProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			provider.calls += 1
			return {
				id: 'r',
				model: 'm',
				message: {
					role: 'assistant',
					content: 'working',
					toolCalls: [
						{
							id: `call_${provider.calls}`,
							type: 'function',
							function: { name: 'noop', arguments: '{}' },
						},
					],
				},
				finishReason: 'tool_calls',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

const noopTool: ToolDefinition<Record<string, never>> = {
	name: 'noop',
	description: 'does nothing',
	inputSchema: z.object({}).strict() as unknown as z.ZodType<
		Record<string, never>,
		z.ZodTypeDef,
		unknown
	>,
	async execute() {
		return { success: true, output: 'ok' }
	},
}

const dirs: string[] = []

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-ses017-'))
	dirs.push(dir)
	return dir
}

function runsDir(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

function cost(totalCost: number): CostInfo {
	return {
		inputCostPer1M: PRICING.inputCostPer1M,
		outputCostPer1M: PRICING.outputCostPer1M,
		totalCost,
		cacheDiscount: 0,
	}
}

/**
 * Write a checkpoint for `RUN_ID` through the production write path, so the resume
 * reads exactly what a real interrupted run would have left behind.
 */
async function seedCheckpoint(
	cwd: string,
	state: {
		tokenUsage?: Partial<TokenUsage>
		totalCost?: number
		iterationCount?: number
		elapsedMs?: number
		/** Calendar age of the checkpoint file. Defaults to "just now". */
		ageMs?: number
	},
): Promise<IterationCheckpoint> {
	const store = new RunDiskStore({ baseDir: runsDir(cwd) })
	await store.initRun(RUN_ID)

	const checkpoint: IterationCheckpoint = {
		id: CHECKPOINT_ID,
		runId: RUN_ID,
		iteration: state.iterationCount ?? 1,
		// Ends with an assistant message carrying content, i.e. a clean stopping
		// point with no dangling tool call for `prepareResumeMessages` to repair.
		messages: [
			createUserMessage('the original request'),
			{ role: 'assistant', content: 'progress so far' } as Message,
		],
		tokenUsage: { ...USAGE, ...state.tokenUsage },
		costInfo: cost(state.totalCost ?? 0),
		guardState: {
			iterationCount: state.iterationCount ?? 1,
			elapsedMs: state.elapsedMs ?? 0,
		},
		createdAt: Date.now() - (state.ageMs ?? 0),
	}

	await store.writeCheckpoint(checkpoint)
	return checkpoint
}

async function resume(opts: {
	cwd: string
	provider: LLMProvider
	tools?: ToolRegistry
	runConfig?: Partial<AgentRunConfig>
}): Promise<Run> {
	return drainQuery({
		provider: opts.provider,
		tools: opts.tools ?? new ToolRegistry(),
		runConfig: {
			model: 'm',
			tokenBudget: 1_000_000,
			timeoutMs: 600_000,
			maxIterations: 50,
			...opts.runConfig,
		},
		agentId: 'agent_test',
		agentName: 'Test',
		workingDirectory: opts.cwd,
		pricing: PRICING,
		messages: [],
		runId: RUN_ID,
		resumeFromCheckpoint: CHECKPOINT_ID,
		sessionId: SESSION_ID,
		threadId: THREAD_ID,
		projectId: PROJECT_ID,
		tenantId: TENANT_ID,
	})
}

/** The `run.json` the run left on disk. */
function readRunMeta(cwd: string): { tokenUsage: TokenUsage; currentIteration: number } {
	const path = join(runsDir(cwd), RUN_ID, 'run.json')
	return JSON.parse(readFileSync(path, 'utf-8'))
}

afterEach(() => {
	dirs.length = 0
})

describe('resume — token budget is a lifetime limit', () => {
	it('continues from the tokens the checkpoint already spent, not from zero', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, {
			tokenUsage: { promptTokens: 40_000, completionTokens: 10_000, totalTokens: 50_000 },
		})

		const provider = stoppingProvider()
		const run = await resume({ cwd, provider })

		// 50k carried in + one more iteration's 2k. Not 2k.
		expect(run.tokenUsage.totalTokens).toBe(50_000 + USAGE.totalTokens)
		expect(provider.calls).toBe(1)
	})

	it('hard-stops a resume whose checkpoint already exhausted the token budget', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, {
			tokenUsage: { promptTokens: 60_000, completionTokens: 40_000, totalTokens: 100_000 },
		})

		const provider = loopingProvider()
		const run = await resume({
			cwd,
			provider,
			runConfig: { tokenBudget: 100_000 },
		})

		expect(run.stopReason).toBe('token_budget')
		expect(provider.calls).toBe(0)
	})
})

describe('resume — cost limit is a lifetime limit', () => {
	it('continues from the dollars the checkpoint already spent', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, { totalCost: 1.5 })

		const provider = stoppingProvider()
		const run = await resume({ cwd, provider, runConfig: { costLimitUsd: 10 } })

		expect(run.costInfo.totalCost).toBeCloseTo(1.5 + COST_PER_CALL, 6)
		expect(provider.calls).toBe(1)
	})

	it('hard-stops immediately when the carried-over spend is already at the cap', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, { totalCost: 5 })

		const provider = loopingProvider()
		const run = await resume({
			cwd,
			provider,
			tools: registryWithNoop(),
			runConfig: { costLimitUsd: 5 },
		})

		// The whole point: no fresh allowance. Not one model call is made, so the
		// resume cannot spend a second budget's worth of money.
		expect(run.stopReason).toBe('cost_limit')
		expect(provider.calls).toBe(0)
		expect(run.costInfo.totalCost).toBeCloseTo(5, 6)
	})
})

describe('resume — iteration count continues', () => {
	it('gives a run resumed at maxIterations - 1 exactly one more iteration', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, { iterationCount: 9 })

		const provider = loopingProvider()
		const run = await resume({
			cwd,
			provider,
			tools: registryWithNoop(),
			runConfig: { maxIterations: 10 },
		})

		expect(provider.calls).toBe(1)
		expect(run.currentIteration).toBe(10)
		expect(run.stopReason).toBe('max_iterations')
	})
})

describe('resume — timeoutMs measures ACTIVE execution time', () => {
	it('does not hand a resumed run a fresh full timeout', async () => {
		const cwd = tmp()
		// The run already burned its whole 60s of execution time before it stopped.
		await seedCheckpoint(cwd, { elapsedMs: 60_000 })

		const provider = loopingProvider()
		const run = await resume({
			cwd,
			provider,
			tools: registryWithNoop(),
			runConfig: { timeoutMs: 60_000 },
		})

		expect(run.stopReason).toBe('timeout')
		expect(provider.calls).toBe(0)
	})

	it('does not charge the run for the days a human spent thinking about an approval', async () => {
		const cwd = tmp()
		// Checkpointed three days ago having executed for 10ms. Calendar time since
		// then is enormous; active execution time is ~nothing. The run must resume.
		await seedCheckpoint(cwd, { elapsedMs: 10, ageMs: 3 * 24 * 60 * 60 * 1000 })

		const provider = stoppingProvider()
		const run = await resume({ cwd, provider, runConfig: { timeoutMs: 60_000 } })

		expect(run.stopReason).toBe('end_turn')
		expect(provider.calls).toBe(1)
	})

	it('records the run’s whole active elapsed in the checkpoints it writes next', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, { elapsedMs: 30_000, iterationCount: 1 })

		// A tool call drives the iteration checkpoint phase, which writes a NEW
		// checkpoint mid-run. Its elapsed must include the 30s the earlier segments
		// spent — derived from the segment's `startedAt` it would read as ~0, and the
		// next resume would silently refund the 30s.
		const provider = loopingProvider()
		await resume({
			cwd,
			provider,
			tools: registryWithNoop(),
			runConfig: { maxIterations: 2, timeoutMs: 600_000 },
		})

		const store = new RunDiskStore({ baseDir: runsDir(cwd) })
		await store.initRun(RUN_ID)
		const written = (await store.listCheckpoints()).filter((cp) => cp.id !== CHECKPOINT_ID)

		expect(written.length).toBeGreaterThan(0)
		for (const cp of written) {
			expect(cp.guardState.elapsedMs).toBeGreaterThanOrEqual(30_000)
		}
	})
})

describe('resume — the restored ledger reaches disk', () => {
	it('does not let init() write a zeroed run.json over the restored usage', async () => {
		const cwd = tmp()
		await seedCheckpoint(cwd, {
			tokenUsage: { promptTokens: 40_000, completionTokens: 10_000, totalTokens: 50_000 },
			iterationCount: 3,
		})

		// Read `run.json` from INSIDE the loop. `init()` is the only thing that has
		// written it at this point — the terminal `persist()` has not run yet — so this
		// is what a crash mid-run, or anything else reading the run's state while it
		// executes, would see. Hydrating after `init()` instead of before it would leave
		// a zeroed ledger sitting here.
		let midRun: ReturnType<typeof readRunMeta> | undefined
		const provider = stoppingProvider(() => {
			midRun = readRunMeta(cwd)
		})
		await resume({ cwd, provider })

		expect(midRun?.tokenUsage.totalTokens).toBe(50_000)
		expect(midRun?.currentIteration).toBe(3)

		// And the final write carries the accumulated total, not just this segment's.
		const meta = readRunMeta(cwd)
		expect(meta.tokenUsage.totalTokens).toBe(50_000 + USAGE.totalTokens)
		expect(meta.currentIteration).toBe(4)
	})
})

function registryWithNoop(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(noopTool as unknown as ToolDefinition)
	return tools
}
