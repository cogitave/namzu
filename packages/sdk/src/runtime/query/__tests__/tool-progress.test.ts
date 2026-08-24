import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
import { NOOP_LOGGER } from '../../../utils/log/create-logger.js'
import { ToolExecutor } from '../executor.js'
import { drainQuery } from '../index.js'

/**
 * A tool may run for the full per-tool deadline — two minutes by default —
 * and was silent for all of it. A host could show that a build had started
 * and then nothing at all until it finished or timed out.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function reportingTool(report: (ctx: ToolContext) => void): ToolDefinition {
	return {
		name: 'build',
		description: 'Build the project',
		inputSchema: z.object({}),
		execute: (_input: unknown, ctx: ToolContext) => {
			report(ctx)
			return Promise.resolve({ success: true, output: 'built' })
		},
	} as unknown as ToolDefinition
}

async function run(tool: ToolDefinition, observe?: (event: RunEvent) => void | Promise<void>) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-progress-'))
	dirs.push(workingDirectory)

	const tools = new ToolRegistry()
	tools.register(tool)
	const events: RunEvent[] = []

	const result = await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [{ toolCalls: [{ name: 'build', args: {} }] }, { text: 'done' }],
			}),
			tools,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 256,
			},
			agentId: 'agent_p',
			agentName: 'Progress',
			messages: [createUserMessage('build it')],
			workingDirectory,
			sessionId: 'ses_p' as SessionId,
			topicId: 'top_p' as TopicId,
			projectId: 'prj_p' as ProjectId,
			tenantId: 'tnt_p' as TenantId,
		},
		async (e) => {
			events.push(e)
			await observe?.(e)
		},
	)

	return { result, events }
}

describe('a long-running tool can say how far along it is', () => {
	it('reaches the host as an event naming the call it belongs to', async () => {
		const { events } = await run(
			reportingTool((ctx) => {
				ctx.report?.('compiled 40/120 files', 0.33)
			}),
		)

		const progress = events.find(
			(e): e is Extract<RunEvent, { type: 'tool_progress' }> => e.type === 'tool_progress',
		)
		expect(progress).toBeDefined()
		expect(progress?.message).toBe('compiled 40/120 files')
		expect(progress?.fraction).toBeCloseTo(0.33)
		// A batch can run several tools at once, so a host rendering them
		// side by side needs to know whose progress this is.
		expect(progress?.toolName).toBe('build')
		expect(progress?.toolUseId).toBeTruthy()
	})

	it('clamps a fraction a tool gets wrong rather than passing it on', async () => {
		const { events } = await run(
			reportingTool((ctx) => {
				ctx.report?.('overshot', 4.2)
				ctx.report?.('undershot', -1)
			}),
		)

		const fractions = events
			.filter((e): e is Extract<RunEvent, { type: 'tool_progress' }> => e.type === 'tool_progress')
			.map((e) => e.fraction)
		expect(fractions).toEqual([1, 0])
	})

	it('is ephemeral, so a chatty tool cannot bloat the durable record', () => {
		expect(
			isEphemeralEvent({
				type: 'tool_progress',
				runId: 'run_x' as never,
				toolUseId: 'call_x' as never,
				toolName: 'build',
				message: 'x',
			} as RunEvent),
		).toBe(true)
	})

	it('reporting never throws back into the tool', async () => {
		// The property a tool author relies on: `report()` is fire-and-forget
		// and returns void, so a tool can call it without wrapping it.
		//
		// Note what this does NOT claim: a HOST listener that throws still
		// kills the run, because `drainQuery` awaits the listener unguarded
		// for every event type. That is a general contract, not something
		// specific to progress, and it is not this feature's to change.
		let threw = false
		const { result } = await run(
			reportingTool((ctx) => {
				try {
					ctx.report?.('tick', 0.5)
					ctx.report?.('tock')
				} catch {
					threw = true
				}
			}),
		)

		expect(threw).toBe(false)
		expect(result.result).toBe('done')
	})

	it('coalesces behind a slow host, bounds UTF-8 bytes, and settles before completion', async () => {
		let releaseFirst!: () => void
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		let observeFirst!: () => void
		const firstObserved = new Promise<void>((resolve) => {
			observeFirst = resolve
		})
		let held = false
		const finalTail = 'LATEST-STATE-😀'
		const pending = run(
			reportingTool((ctx) => {
				ctx.report?.('first state', 0.01)
				for (let index = 0; index < 10_000; index += 1) {
					ctx.report?.(`intermediate ${index}`)
				}
				ctx.report?.(`${'x'.repeat(20_000)}${finalTail}`, 0.75)
			}),
			async (event) => {
				if (event.type !== 'tool_progress' || held) return
				held = true
				observeFirst()
				await firstReleased
			},
		)

		await firstObserved
		releaseFirst()
		const { events, result } = await pending
		const progress = events.filter(
			(event): event is Extract<RunEvent, { type: 'tool_progress' }> =>
				event.type === 'tool_progress',
		)
		expect(progress).toHaveLength(2)
		expect(progress[0]?.message).toBe('first state')
		expect(progress[1]?.message.startsWith('… ')).toBe(true)
		expect(progress[1]?.message.endsWith(finalTail)).toBe(true)
		expect(Buffer.byteLength(progress[1]?.message ?? '', 'utf8')).toBeLessThanOrEqual(8 * 1024)
		expect(progress[1]?.fraction).toBe(0.75)

		const lastProgress = events.map((event) => event.type).lastIndexOf('tool_progress')
		const completed = events.findIndex(
			(event) => event.type === 'tool_completed' && event.toolName === 'build',
		)
		expect(lastProgress).toBeGreaterThan(-1)
		expect(completed).toBeGreaterThan(lastProgress)
		// Event bounding is a live-view projection only. The durable tool result
		// remains the exact value the tool returned.
		expect(result.messages).toContainEqual(
			expect.objectContaining({ role: 'tool', content: 'built' }),
		)
	})

	it('does not publish completion while an accepted progress update is still held', async () => {
		let releaseProgress!: () => void
		const progressReleased = new Promise<void>((resolve) => {
			releaseProgress = resolve
		})
		let observeProgress!: () => void
		const progressObserved = new Promise<void>((resolve) => {
			observeProgress = resolve
		})
		const observed: string[] = []
		const runId = 'run_progress_order' as RunId
		const tools = new ToolRegistry()
		tools.register(
			reportingTool((ctx) => {
				ctx.report?.('held')
				ctx.report?.('latest')
			}),
		)
		const executor = new ToolExecutor(
			{
				tools,
				runId,
				workingDirectory: process.cwd(),
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(runId, {
				enabled: false,
				trackToolCalls: false,
				trackLlmTurns: false,
			}),
			async (event) => {
				observed.push(event.type)
				if (event.type !== 'tool_progress' || event.message !== 'held') return
				observeProgress()
				await progressReleased
			},
			NOOP_LOGGER,
		)
		const response = {
			id: 'response_progress',
			model: 'mock-model',
			message: {
				role: 'assistant',
				content: null,
				toolCalls: [
					{ id: 'call_progress', type: 'function', function: { name: 'build', arguments: '{}' } },
				],
			},
			finishReason: 'tool_calls',
			usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
		} as ChatCompletionResponse
		const pending = executor.executeBatch(response)

		await progressObserved
		// Drain the current turn's promise continuations. With no progress fence,
		// executeSingle reaches tool_completed before this event-loop boundary.
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(observed).not.toContain('tool_completed')
		releaseProgress()
		await pending
		expect(observed.filter((type) => type === 'tool_progress')).toHaveLength(2)
		expect(observed.at(-1)).toBe('tool_completed')
	})

	it('a tool that reports nothing produces no events', async () => {
		const { events } = await run(reportingTool(() => {}))
		expect(events.some((e) => e.type === 'tool_progress')).toBe(false)
	})
})
