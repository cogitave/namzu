import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AuthorizationGate } from '../../../authorization/gate.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { AuthorizationRule } from '../../../types/authorization/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolDispatchOptions, ToolResult } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor } from '../executor.js'

const turnId = 'e2d37322-06f5-48ad-9575-2f16bd7bb972' as TurnId
const sessionId = '4a71d2e5-6938-4d6c-a221-d6a65306e4cc' as SessionId

/**
 * A call one tool makes to another (a skill running the shell tool while it
 * loads) may carry a pre-approval for that one dispatch and a last word before
 * the call starts. The pre-approval answers only what no rule decided; the last
 * word can only refuse.
 */

function harness(rules: AuthorizationRule[], options: ToolDispatchOptions | undefined) {
	const ran: string[] = []
	const outcome: ToolResult[] = []
	const events: SessionEventDraft[] = []
	const log = {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => log,
	} as unknown as Logger
	const tools = new ToolManager({
		toolsets: [
			testToolset(
				defineTool({
					name: 'parent',
					description: 'parent',
					inputSchema: z.object({}),
					category: 'analysis',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async (_input, context) => {
						outcome.push(
							(await context.dispatchTool?.('child', { command: 'ls' }, options)) as ToolResult,
						)
						return { success: true, output: 'done' }
					},
				}),
				defineTool({
					name: 'child',
					description: 'child',
					inputSchema: z.object({ command: z.string() }),
					category: 'shell',
					permissions: [],
					readOnly: false,
					destructive: false,
					concurrencySafe: true,
					execute: async (input) => {
						ran.push(input.command)
						return { success: true, output: 'ran' }
					},
				}),
			),
		],
		messages: () => [],
	})
	const executor = new ToolExecutor(
		{
			tools,
			sessionId,
			turnId,
			workingDirectory: '/tmp',
			env: {},
			permissionMode: 'auto',
			abortSignal: new AbortController().signal,
			authorizationGate: new AuthorizationGate(
				{
					enabled: true,
					rules,
					allowReadOnlyTools: false,
					denyDangerousPatterns: false,
					logDecisions: false,
				},
				log,
			),
			recordAudit: async () => undefined,
			toolRetryBackoff: { initialDelayMs: 0 },
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async (event) => {
			events.push(event)
		},
		log,
	)
	const call = {
		id: 'c0',
		type: 'function' as const,
		function: { name: 'parent', arguments: '{}' },
	}
	return {
		ran,
		outcome,
		events,
		run: () =>
			executor.executeBatch({
				id: 'r',
				model: 'mock',
				message: { role: 'assistant', content: null, toolCalls: [call] },
				finishReason: 'tool_calls',
				usage: {
					promptTokens: 0,
					completionTokens: 0,
					totalTokens: 0,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
			}),
	}
}

const allowParent: AuthorizationRule = { type: 'allow_by_name', toolNames: ['parent'] }

describe('a nested call with a pre-approval', () => {
	it('is refused with no rule and no pre-approval', async () => {
		const h = harness([allowParent], undefined)
		await h.run()
		expect(h.ran).toEqual([])
		expect(h.outcome[0]?.error).toContain('requires an explicit allow rule')
	})

	it('runs when the pre-approval covers a call no rule decided', async () => {
		const allow = vi.fn(() => true)
		const h = harness([allowParent], { allow })
		await h.run()
		expect(h.ran).toEqual(['ls'])
		expect(allow).toHaveBeenCalledWith({ name: 'child', input: { command: 'ls' } })
	})

	it('is not asked for a call a rule already allowed', async () => {
		const allow = vi.fn(() => false)
		const h = harness([allowParent, { type: 'allow_by_name', toolNames: ['child'] }], { allow })
		await h.run()
		expect(h.ran).toEqual(['ls'])
		expect(allow).not.toHaveBeenCalled()
	})

	it('never reopens a call a rule denied', async () => {
		const h = harness([allowParent, { type: 'deny_by_name', toolNames: ['child'] }], {
			allow: () => true,
		})
		await h.run()
		expect(h.ran).toEqual([])
		expect(h.outcome[0]?.error).toContain('denied by name')
	})

	it('never answers a call a rule sent to review on purpose', async () => {
		const h = harness(
			[
				allowParent,
				{
					type: 'argument_pattern',
					toolNames: ['child'],
					argument: 'command',
					pattern: '.*',
					decision: 'review',
				},
			],
			{ allow: () => true },
		)
		await h.run()
		expect(h.ran).toEqual([])
	})

	it('says no when the pre-approval says no', async () => {
		const h = harness([allowParent], { allow: () => false })
		await h.run()
		expect(h.ran).toEqual([])
	})
})

describe('a nested call with a last word', () => {
	it('runs when the answer is nothing', async () => {
		const beforeRun = vi.fn(async () => undefined)
		const h = harness([allowParent, { type: 'allow_by_name', toolNames: ['child'] }], { beforeRun })
		await h.run()
		expect(h.ran).toEqual(['ls'])
		expect(beforeRun).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'child', input: { command: 'ls' } }),
		)
	})

	it('does not start the call, and writes no tool event for it, when the answer is a reason', async () => {
		const h = harness([allowParent, { type: 'allow_by_name', toolNames: ['child'] }], {
			beforeRun: async () => 'not today',
		})
		await h.run()
		expect(h.ran).toEqual([])
		expect(h.outcome[0]).toEqual({ success: false, output: '', error: 'not today' })
		const started = h.events.filter(
			(event) => event.type === 'tool_executing' && event.toolName === 'child',
		)
		expect(started).toEqual([])
	})

	it('is not asked when the call was refused first', async () => {
		const beforeRun = vi.fn(async () => undefined)
		const h = harness([allowParent], { beforeRun })
		await h.run()
		expect(beforeRun).not.toHaveBeenCalled()
	})

	it('is asked after a pre-approval answered the call', async () => {
		const order: string[] = []
		const h = harness([allowParent], {
			allow: () => {
				order.push('allow')
				return true
			},
			beforeRun: async () => {
				order.push('beforeRun')
				return undefined
			},
		})
		await h.run()
		expect(order).toEqual(['allow', 'beforeRun'])
		expect(h.ran).toEqual(['ls'])
	})
})
