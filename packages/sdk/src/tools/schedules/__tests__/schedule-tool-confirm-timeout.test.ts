import { describe, expect, it, vi } from 'vitest'
import { ToolExecutor } from '../../../runtime/query/executor.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { generateSessionId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { buildScheduleTools } from '../schedule-tool.js'
import type {
	ScheduleConfirmAnswer,
	ScheduleConfirmRequest,
	ScheduleJobPreview,
	ScheduleJobSummary,
	ScheduleToolHost,
} from '../types.js'

/**
 * `host.confirm` / `host.confirmAction` wait on a person reading a screen —
 * seconds to minutes, not milliseconds. The executor's per-tool deadline
 * (`DEFAULT_TOOL_TIMEOUT_MS`, 120s, or a shorter `toolTimeoutMs` a caller
 * configures) has no idea a human is on the other end and abandons the call
 * out from under them, reporting a false timeout though the operator may
 * still be about to answer. A tool that legitimately runs long declares its
 * own `timeoutMs`; `schedule` did not.
 */

const SESSION_ID = generateSessionId()
const TURN_ID = 'b4e6a6b1-3e9e-4c1a-9a8d-8a0a7c6d9e21' as TurnId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

function response(name: string, args: Record<string, unknown>): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'm',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_0',
					type: 'function' as const,
					function: { name, arguments: JSON.stringify(args) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

function harness(opts: {
	tool: ToolDefinition
	toolTimeoutMs?: number
	abortSignal?: AbortSignal
}): ToolExecutor {
	const tools = {
		get: vi.fn((name: string) => (name === opts.tool.name ? opts.tool : undefined)),
		execute: vi.fn(async (_name: string, input: unknown, ctx: never) =>
			opts.tool.execute(input, ctx),
		),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		availability: vi.fn(() => 'active'),
	} as unknown as ToolManager

	return new ToolExecutor(
		{
			sessionId: SESSION_ID,
			tools,
			turnId: TURN_ID,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: opts.abortSignal ?? new AbortController().signal,
			...(opts.toolTimeoutMs !== undefined ? { toolTimeoutMs: opts.toolTimeoutMs } : {}),
		},
		new ActivityStore(TURN_ID, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
		async () => {},
		makeLogger(),
	)
}

const PREVIEW: ScheduleJobPreview = {
	name: 'host-name',
	folder: '/canonical/folder',
	outsideSessionRoots: false,
	prompt: 'host copy of the prompt',
	schedule: 'at 03:00 every day (UTC)',
	nextFireTimes: ['2026-09-24T03:00:00.000Z'],
	rules: ['read: allow'],
	unmatched: 'park',
	execution: 'host',
	networkAccess: false,
	budget: { maxIterations: 50, tokenBudget: 500_000, timeoutMs: 1_800_000 },
	dailyTokenCeiling: 500_000,
	model: 'mock/model',
	warnings: [],
}

const CREATE_ARGS = {
	action: 'create',
	name: 'nightly',
	prompt: 'check dependencies',
	when: '0 3 * * *',
	permissions: { preset: 'read-only', unmatched: 'deny' },
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

function hostWithSlowConfirm(delayMs: number, answer: ScheduleConfirmAnswer): ScheduleToolHost {
	const job: ScheduleJobSummary = {
		name: 'nightly',
		folder: '/f',
		state: 'active',
		schedule: 'daily',
	}
	return {
		preview: async () => PREVIEW,
		confirm: async () => {
			await sleep(delayMs)
			return answer
		},
		create: async (_d, p) => ({ name: p.name }),
		list: async () => [job],
		find: async (name) => (name === 'nightly' ? job : undefined),
		confirmAction: async () => answer === 'create',
		pause: async () => {},
		resume: async () => {},
		delete: async () => {},
	}
}

describe('schedule tool — a person answering the confirmation is not the executor default deadline', () => {
	it('does not abandon a create still waiting on the operator well within the executor default', async () => {
		// The operator takes 200ms to read and answer; the turn configured a
		// 50ms per-tool deadline (stand-in for the 120s default cutting off a
		// slower read). The tool's own declared timeout must win.
		const [tool] = buildScheduleTools(hostWithSlowConfirm(200, 'create'))
		if (!tool) throw new Error('no tool')
		const exec = harness({ tool, toolTimeoutMs: 50 })
		const batch = await exec.executeBatch(response('schedule', CREATE_ARGS))
		expect(batch.results).toHaveLength(1)
		expect(batch.results[0]?.output ?? '').not.toContain('timed out')
		expect(batch.results[0]?.isError).toBe(false)
	})

	it('turn abort reaches the pending confirm instead of leaving it to hang until the deadline', async () => {
		let confirmSignal: AbortSignal | undefined
		const job: ScheduleJobSummary = {
			name: 'nightly',
			folder: '/f',
			state: 'active',
			schedule: 'daily',
		}
		const host: ScheduleToolHost = {
			preview: async () => PREVIEW,
			confirm: (_req: ScheduleConfirmRequest, signal?: AbortSignal) => {
				confirmSignal = signal
				// A screen with nobody answering it: only the turn's own abort
				// (or the tool's deadline) should ever settle this.
				return new Promise<ScheduleConfirmAnswer>(() => {})
			},
			create: async (_d, p) => ({ name: p.name }),
			list: async () => [job],
			find: async () => job,
			confirmAction: async () => false,
			pause: async () => {},
			resume: async () => {},
			delete: async () => {},
		}
		const [tool] = buildScheduleTools(host)
		if (!tool) throw new Error('no tool')
		const controller = new AbortController()
		const exec = harness({ tool, toolTimeoutMs: 60_000, abortSignal: controller.signal })
		const pending = exec.executeBatch(response('schedule', CREATE_ARGS))
		await sleep(20)
		controller.abort(new Error('operator stopped the turn'))
		// No real 1000ms safety race: it competed with the same clock as the
		// cancellation work it waited on, so a starved CI runner could make
		// that work outlast the guard with nothing actually broken. A
		// regression that left this unresolved now hangs and fails on
		// Vitest's own per-test timeout instead.
		const batch = await pending
		expect(confirmSignal).toBeDefined()
		expect(confirmSignal?.aborted).toBe(true)
		expect(batch.results[0]?.isError).toBe(true)
	})
})
