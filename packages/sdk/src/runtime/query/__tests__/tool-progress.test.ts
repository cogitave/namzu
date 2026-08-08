import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolContext, ToolDefinition } from '../../../types/tool/index.js'
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

async function run(tool: ToolDefinition) {
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
			threadId: 'thd_p' as ThreadId,
			projectId: 'prj_p' as ProjectId,
			tenantId: 'tnt_p' as TenantId,
		},
		(e) => {
			events.push(e)
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

	it('a tool that reports nothing produces no events', async () => {
		const { events } = await run(reportingTool(() => {}))
		expect(events.some((e) => e.type === 'tool_progress')).toBe(false)
	})
})
