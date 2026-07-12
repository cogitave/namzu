// Current-code invariants asserted (2026-07-12, ses_017 P2):
//
// Namzu had no non-terminal run state. A run that paused for a human was persisted
// as FINISHED: `pause` only set a `stopReason`, `query()` then unconditionally fired
// `run_end` hooks + `run_completed` and called `ResultAssembler.completeRun()`, which
// marked the still-`running` run **completed**, stamped `endedAt`, and promoted the
// last assistant message — the one whose tool calls were awaiting review — to the
// run's `result`. Every durable-pause design in production is built on a state namzu
// did not have.
//
//   - A run whose review handler answers `pause` ends `awaiting_input`. It is NOT
//     `completed`, NOT `failed`, NOT `cancelled`, and `isTerminalStatus` says so.
//   - It has NO `endedAt`. Nothing may compute a duration for a run that is still
//     going to run again.
//   - It resolves NO `result`. The pending assistant turn is not an answer.
//   - It emits NO `run_completed` (and no `run_failed`). It DOES emit `run_paused`,
//     carrying the checkpoint the pause can be resumed from.
//   - The `run_end` plugin hook does NOT fire. The run has not ended; firing it here
//     would fire it a second time on resume, and a plugin that tears down on
//     `run_end` would tear down a live run.
//   - The suspension REACHES DISK: `run.json` says `awaiting_input` with no `endedAt`,
//     so a process that dies while a human is thinking leaves a run that reads as
//     waiting, not as finished.
//   - The pending tool call is left UNANSWERED in the history on purpose — it is what
//     a resume must act on.
//   - The terminal path is unchanged: a run that ends its turn is still `completed`,
//     with `endedAt`, a `result`, a `run_completed` event and a `run_end` hook.
//   - `abort` is still terminal (`cancelled`) — pause and abort were the same signal
//     before this change, and separating them must not have merged them the other way.
//
// These tests drive the real `query()` loop against a fake provider and a real
// `RunDiskStore`, through the production `drainQuery` entry point.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { isTerminalStatus } from '../../../types/common/index.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type { ProjectId, RunId, SessionId, TenantId, ThreadId } from '../../../types/ids/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { drainQuery } from '../index.js'

const RUN_ID = 'run_suspend_test' as RunId
const SESSION_ID = 'ses_test' as SessionId
const THREAD_ID = 'thr_test' as ThreadId
const PROJECT_ID = 'prj_test' as ProjectId
const TENANT_ID = 'tnt_test' as TenantId

const USAGE = {
	promptTokens: 10,
	completionTokens: 10,
	totalTokens: 20,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** Asks for a tool call, which is what drives the run into the review phase. */
function toolCallingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: {
					role: 'assistant',
					content: 'I will write the file now',
					toolCalls: [
						{
							id: 'call_1',
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
}

/** Ends its turn immediately — the un-paused control case. */
function stoppingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'all done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
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

function registryWithNoop(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(noopTool as unknown as ToolDefinition)
	return tools
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-p2-'))
}

function runMetaOnDisk(cwd: string): { status: string; endedAt?: number; result?: string } {
	const runsDir = join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
	return JSON.parse(readFileSync(join(runsDir, RUN_ID, 'run.json'), 'utf-8'))
}

interface Driven {
	run: Run
	events: RunEvent[]
	hooks: string[]
}

/**
 * Drive a full run through the production entry point, answering whatever HITL
 * request arrives with `decision`.
 */
async function drive(opts: {
	cwd: string
	provider: LLMProvider
	decision: HITLResumeDecision
}): Promise<Driven> {
	const events: RunEvent[] = []
	const hooks: string[] = []

	// A minimal stand-in for the plugin manager: it records which lifecycle hooks
	// `query()` chose to fire. `run_end` firing on a suspension is the specific
	// defect this catches.
	const pluginManager = {
		async executeHooks(event: string) {
			hooks.push(event)
			return []
		},
	} as unknown as NonNullable<Parameters<typeof drainQuery>[0]['pluginManager']>

	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: registryWithNoop(),
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			pluginManager,
			resumeHandler: async (_req: HITLDecisionRequest) => opts.decision,
		},
		(e) => {
			events.push(e)
		},
	)

	return { run, events, hooks }
}

describe('a run that pauses for a human is SUSPENDED, not finished', () => {
	it('ends awaiting_input — not completed, not failed, not terminal', async () => {
		const { run } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'need to check with legal' },
		})

		expect(run.status).toBe('awaiting_input')
		expect(isTerminalStatus(run.status)).toBe(false)
		expect(run.stopReason).toBe('paused')
	})

	it('has no endedAt — nothing may compute a duration for a run that will run again', async () => {
		const { run } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		expect(run.endedAt).toBeUndefined()
	})

	it('resolves no result — the half-finished turn awaiting review is not an answer', async () => {
		const { run } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		// `markCompleted` would have promoted "I will write the file now" — the very
		// message whose tool calls are pending review — to the run's result.
		expect(run.result).toBeUndefined()
	})

	it('emits run_paused and NOT run_completed', async () => {
		const { events } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		const types = events.map((e) => e.type)
		expect(types).toContain('run_paused')
		expect(types).not.toContain('run_completed')
		expect(types).not.toContain('run_failed')

		const paused = events.find((e) => e.type === 'run_paused')
		// The pause names the checkpoint it can be resumed from — without it the
		// event announces a state nothing can act on.
		expect(paused).toMatchObject({ runId: RUN_ID, reason: 'stepping away' })
		expect((paused as { checkpointId: string }).checkpointId).toMatch(/^cp_/)
	})

	it('does not fire the run_end plugin hook — the run has not ended', async () => {
		const { hooks } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		expect(hooks).toContain('run_start')
		expect(hooks).not.toContain('run_end')
	})

	it('writes the suspension to disk — a crash mid-pause leaves a run that reads as waiting', async () => {
		const cwd = tmp()
		await drive({
			cwd,
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		const meta = runMetaOnDisk(cwd)
		expect(meta.status).toBe('awaiting_input')
		expect(meta.endedAt).toBeUndefined()
		expect(meta.result).toBeUndefined()
	})

	it('leaves the pending tool call unanswered — it is what a resume must act on', async () => {
		const { run } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'pause', reason: 'stepping away' },
		})

		const last = run.messages.at(-1)
		expect(last?.role).toBe('assistant')
		expect((last as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1)
		// No tool result was written for it, and the tool never ran.
		expect(run.messages.some((m) => m.role === 'tool')).toBe(false)
	})
})

describe('the terminal paths are unchanged', () => {
	it('a run that ends its turn is still completed, with endedAt, a result and run_completed', async () => {
		const cwd = tmp()
		const { run, events, hooks } = await drive({
			cwd,
			provider: stoppingProvider(),
			decision: { action: 'continue' },
		})

		expect(run.status).toBe('completed')
		expect(isTerminalStatus(run.status)).toBe(true)
		expect(run.endedAt).toBeTypeOf('number')
		expect(run.result).toBe('all done')
		expect(events.map((e) => e.type)).toContain('run_completed')
		expect(hooks).toContain('run_end')

		const meta = runMetaOnDisk(cwd)
		expect(meta.status).toBe('completed')
		expect(meta.endedAt).toBeTypeOf('number')
	})

	it('abort still terminalizes the run as cancelled — pause and abort are not the same signal', async () => {
		const { run, events } = await drive({
			cwd: tmp(),
			provider: toolCallingProvider(),
			decision: { action: 'abort', reason: 'no' },
		})

		expect(run.status).toBe('cancelled')
		expect(isTerminalStatus(run.status)).toBe(true)
		expect(run.endedAt).toBeTypeOf('number')
		expect(events.map((e) => e.type)).not.toContain('run_paused')
	})
})
