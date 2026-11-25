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
 * The tool that makes a nested call reads (the `skill` tool), so the review
 * policy never sees the nested one. The turn's review mode answers it here as
 * it answers the same call made directly: `plan` runs only calls that read,
 * `strict` only calls a rule allowed, and a pre-approval lifts neither.
 */

function harness(
	rules: AuthorizationRule[],
	options: ToolDispatchOptions | undefined,
	setup: { mode: string | undefined; childReadOnly: boolean },
) {
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
					readOnly: setup.childReadOnly,
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
			reviewMode: () => setup.mode,
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
const allowChild: AuthorizationRule = { type: 'allow_by_name', toolNames: ['child'] }
const grant: ToolDispatchOptions = { allow: () => true }

describe('a nested call under the turn’s review mode', () => {
	it('is refused in plan mode when it can change something, even with a rule and a grant', async () => {
		const h = harness([allowParent, allowChild], grant, { mode: 'plan', childReadOnly: false })
		await h.run()
		expect(h.ran).toEqual([])
		expect(h.outcome[0]?.error).toContain('plan mode')
	})

	it('runs in plan mode when it only reads', async () => {
		const h = harness([allowParent, allowChild], undefined, { mode: 'plan', childReadOnly: true })
		await h.run()
		expect(h.ran).toEqual(['ls'])
	})

	it('is refused in strict mode when only a pre-approval covers it', async () => {
		const h = harness([allowParent], grant, { mode: 'strict', childReadOnly: false })
		await h.run()
		expect(h.ran).toEqual([])
		expect(h.outcome[0]?.error).toContain('strict mode')
	})

	it('runs in strict mode when a rule allows it', async () => {
		const h = harness([allowParent, allowChild], undefined, {
			mode: 'strict',
			childReadOnly: false,
		})
		await h.run()
		expect(h.ran).toEqual(['ls'])
	})

	it.each([undefined, 'auto', 'prompt', 'accept-edits', 'bypass', 'operator-tui'])(
		'lets a pre-approval answer in %s as before',
		async (mode) => {
			const h = harness([allowParent], grant, { mode, childReadOnly: false })
			await h.run()
			expect(h.ran).toEqual(['ls'])
		},
	)
})
