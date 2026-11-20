/**
 * `task_created` and `task_completed` run before the task tools do, after
 * `pre_tool_use` has let the call through. A refusal keeps the tool from
 * running and its reason reaches the model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { TurnId } from '../../../types/ids/index.js'
import type { PluginHookContext, PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import { generateSessionId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

const turnId = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as TurnId

function logger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function call(toolName: string, args: object): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: toolName, arguments: JSON.stringify(args) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

describe('task hook events', () => {
	let seen: { event: string; context: Partial<PluginHookContext> }[]
	let ran: ReturnType<typeof vi.fn>

	function executor(answer: (event: string) => PluginHookResult[]) {
		seen = []
		ran = vi.fn(async () => ({ success: true, output: 'done' }))
		const tools = {
			execute: ran,
			get: vi.fn(() => undefined),
			has: vi.fn(() => true),
			listNames: vi.fn(() => []),
			availability: vi.fn(() => 'active'),
		} as unknown as ToolManager
		const pluginManager = {
			executeHooks: async (event: string, context: Partial<PluginHookContext>) => {
				seen.push({ event, context })
				return answer(event)
			},
		} as unknown as PluginLifecycleManager
		return new ToolExecutor(
			{
				sessionId: generateSessionId(),
				tools,
				turnId,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
				pluginManager,
			},
			new ActivityStore(turnId, { enabled: true, trackToolCalls: true, trackLlmTurns: true }),
			async () => undefined,
			logger(),
		)
	}

	beforeEach(() => {
		seen = []
	})

	it('task_created fires for task_create with the subject, after pre_tool_use', async () => {
		const exec = executor(() => [])
		await exec.executeBatch(call('task_create', { subject: 'Ship it', description: 'now' }))
		expect(seen.map((entry) => entry.event)).toEqual(
			expect.arrayContaining(['pre_tool_use', 'task_created']),
		)
		expect(seen.findIndex((e) => e.event === 'pre_tool_use')).toBeLessThan(
			seen.findIndex((e) => e.event === 'task_created'),
		)
		expect(seen.find((e) => e.event === 'task_created')?.context.task).toEqual({
			subject: 'Ship it',
			description: 'now',
		})
		expect(ran).toHaveBeenCalled()
	})

	it('task_completed fires for a task_update that completes, with the id; other updates do not', async () => {
		const exec = executor(() => [])
		await exec.executeBatch(call('task_update', { id: 't1', status: 'completed' }))
		expect(seen.find((e) => e.event === 'task_completed')?.context.task).toEqual({ id: 't1' })
		seen.length = 0
		await exec.executeBatch(call('task_update', { id: 't1', status: 'in_progress' }))
		expect(seen.some((e) => e.event === 'task_completed')).toBe(false)
	})

	it('a refusal keeps the tool from running and says why', async () => {
		const exec = executor((event) =>
			event === 'task_created' ? [{ action: 'skip', reason: 'tasks need a ticket' }] : [],
		)
		const batch = await exec.executeBatch(call('task_create', { subject: 'S' }))
		expect(ran).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toContain('tasks need a ticket')
	})

	it('other tools never fire a task event', async () => {
		const exec = executor(() => [])
		await exec.executeBatch(call('echo', {}))
		expect(seen.map((e) => e.event)).toEqual(['pre_tool_use', 'post_tool_use'])
	})
})
