import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { BackgroundJobRegistry } from '../../jobs/registry.js'
import { query } from '../index.js'

/**
 * A job outlives the call that started it, and the model used to learn
 * that it had finished only by asking. Now the exit rides out on the
 * next tool result as a notice, and reaches the host as an event; and a
 * host that binds jobs to its session keeps them past the run's end.
 */

registerMock()

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register(
		defineTool({
			name: 'start',
			description: 'starts a short background job',
			inputSchema: z.object({ command: z.string() }),
			category: 'shell',
			permissions: [],
			readOnly: false,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ command }, context) => {
				const job = context.backgroundJobs?.start({
					command,
					workingDirectory: context.workingDirectory,
				})
				return { success: true, output: `started ${job?.id ?? 'nothing'}` }
			},
		}),
	)
	registry.register(
		defineTool({
			name: 'wait',
			description: 'waits a little',
			inputSchema: z.object({ ms: z.number() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async ({ ms }) => {
				await new Promise((r) => setTimeout(r, ms))
				return { success: true, output: 'waited' }
			},
		}),
	)
	return registry
}

async function run(registry: BackgroundJobRegistry, owner?: string, command = 'exit 3') {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-jobs-'))
	dirs.push(workingDirectory)
	const events: RunEvent[] = []
	let messages: readonly import('../../../types/message/index.js').Message[] = []
	const gen = query({
		provider: new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'start', args: { command } }], finishReason: 'tool_calls' },
				{ toolCalls: [{ id: 'c2', name: 'wait', args: { ms: 400 } }], finishReason: 'tool_calls' },
				{ toolCalls: [{ id: 'c3', name: 'wait', args: { ms: 50 } }], finishReason: 'tool_calls' },
				{ text: 'done' },
			],
		}),
		tools: tools(),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('start the job and wait')],
		workingDirectory,
		sessionId: '59bc2a84-5f39-4558-8db3-5b98a3440946' as SessionId,
		topicId: '8b2d1f0c-eeac-45ba-a525-9bb2750aa30f' as TopicId,
		projectId: 'a7377b40-dd98-40f5-ba59-987dccb8d7e8' as ProjectId,
		tenantId: 'c3952a45-f57f-4273-83a1-511e1acd1a36' as TenantId,
		resumeHandler: async () => ({ action: 'continue' }),
		backgroundJobs: registry,
		...(owner ? { backgroundJobOwner: owner } : {}),
	})
	let next = await gen.next()
	while (!next.done) {
		events.push(next.value)
		next = await gen.next()
	}
	messages = next.value.messages ?? []
	return { events, messages }
}

describe('a finished background job is not polled for', () => {
	it('rides out on the next tool result as a notice, and reaches the host as an event', async () => {
		const registry = new BackgroundJobRegistry()
		const { events, messages } = await run(registry)
		const exited = events.find((e) => e.type === 'background_job_exited')
		expect(exited).toMatchObject({
			jobId: 'job_1',
			command: 'exit 3',
			status: 'exited',
			exitCode: 3,
		})
		const toolTexts = messages
			.filter((m) => m.role === 'tool' && typeof m.content === 'string')
			.map((m) => m.content as string)
		expect(
			toolTexts.some(
				(t) => t.includes('[Background job update]') && t.includes('exited with code 3'),
			),
		).toBe(true)
	})

	it('stops run-owned jobs when the run ends, and leaves session-owned ones to the host', async () => {
		const runOwned = new BackgroundJobRegistry()
		await run(runOwned, undefined, 'sleep 30')
		expect(
			runOwned.list('59bc2a84-5f39-4558-8db3-5b98a3440946').length +
				runOwned.list('f4e0af37-43f7-48fd-82b0-f1b1c68881d3').length,
		).toBe(0)

		const sessionOwned = new BackgroundJobRegistry()
		const { events } = await run(sessionOwned, '59bc2a84-5f39-4558-8db3-5b98a3440946', 'sleep 30')
		const mine = sessionOwned.list('59bc2a84-5f39-4558-8db3-5b98a3440946')
		expect(mine).toHaveLength(1)
		expect(mine[0]?.status).toBe('running')
		expect(events.some((e) => e.type === 'background_job_exited')).toBe(false)
		const stopped = await sessionOwned.killOwner('59bc2a84-5f39-4558-8db3-5b98a3440946')
		expect(stopped).toHaveLength(1)
	})
})
