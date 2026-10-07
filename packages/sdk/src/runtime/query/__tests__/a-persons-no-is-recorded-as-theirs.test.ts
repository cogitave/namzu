/**
 * A person's No and a policy's refusal both reach the model as the same kind
 * of failed tool result. The record has to tell them apart, from a structured
 * field the review answer sets and never from the refusal text, so a
 * conversation reopened later can say "Declined" and show what the person
 * said. A refusal by policy keeps exactly the shape it always had.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type { CheckpointId, TurnId } from '../../../types/ids/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	generateTurnId,
} from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from '../declined.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor } from '../executor.js'
import { drainQuery } from '../index.js'
import { createReviewHandler } from '../review-policy.js'

const logger = (): Logger => {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

const edit = defineTool({
	name: 'edit',
	description: 'Replace text in a file.',
	inputSchema: z.object({ path: z.string(), old_string: z.string(), new_string: z.string() }),
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,
	presentCall: (input) => ({
		kind: 'diff',
		path: input.path,
		before: input.old_string,
		after: input.new_string,
	}),
	execute: async () => ({ success: true, output: 'edited' }),
})

const throwing = defineTool({
	name: 'fragile',
	description: 'A tool whose call presentation throws.',
	inputSchema: z.object({}),
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,
	presentCall: () => {
		throw new Error('boom')
	},
	execute: async () => ({ success: true, output: 'ran' }),
})

const blocked = defineTool({
	name: 'blocked',
	description: 'A tool the gate refuses.',
	inputSchema: z.object({ path: z.string() }),
	category: 'custom',
	permissions: [],
	readOnly: false,
	destructive: true,
	concurrencySafe: false,
	execute: async () => ({ success: true, output: 'ran' }),
})

function response(name: string, args: Record<string, unknown>): ChatCompletionResponse {
	return {
		id: 'declined-response',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
			],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

function fixture() {
	const turnId = generateTurnId()
	const tools = new ToolManager({ toolsets: [testToolset(edit, throwing)], messages: () => [] })
	const events: SessionEventDraft[] = []
	const executor = new ToolExecutor(
		{
			tools,
			turnId,
			sessionId: generateSessionId(),
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async (event) => {
			events.push(event)
		},
		logger(),
	)
	const completed = () => events.filter((event) => event.type === 'tool_completed')
	return { executor, completed }
}

const editCall = () =>
	response('edit', { path: '/repo/src/app.css', old_string: 'a', new_string: 'b' })

describe('a call the person declined', () => {
	it('is recorded with its target and their note, without running', async () => {
		const f = fixture()
		const batch = await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'The user declined this change and said: keep the old colour']]),
			undefined,
			undefined,
			new Map([['call_1', { note: '  keep the old colour  ' }]]),
		)
		expect(batch.results[0]?.isError).toBe(true)
		expect(f.completed()).toEqual([
			expect.objectContaining({
				toolUseId: 'call_1',
				isError: true,
				presentation: {
					kind: 'generic',
					label: '/repo/src/app.css',
					declined: { note: 'keep the old colour' },
				},
			}),
		])
	})

	it('records a bare No as declined with no note', async () => {
		const f = fixture()
		await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', DECLINED_TOOL_CALL_FEEDBACK]]),
			undefined,
			undefined,
			new Map([['call_1', {}]]),
		)
		expect(f.completed()[0]).toMatchObject({
			presentation: { kind: 'generic', label: '/repo/src/app.css', declined: {} },
		})
	})

	it('keeps at most 4,000 characters of the note', async () => {
		const f = fixture()
		await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'no']]),
			undefined,
			undefined,
			new Map([['call_1', { note: 'x'.repeat(9_000) }]]),
		)
		const presentation = f.completed()[0] as { presentation?: { declined?: { note?: string } } }
		expect(presentation.presentation?.declined?.note).toHaveLength(4_000)
	})

	it('keeps markup and newlines in the note verbatim, and never splits a character at the cap', async () => {
		const f = fixture()
		const markup = '<b onclick="x()">no</b>\nline two & `tick`'
		await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'no']]),
			undefined,
			undefined,
			new Map([['call_1', { note: markup }]]),
		)
		expect(f.completed()[0]).toMatchObject({ presentation: { declined: { note: markup } } })

		const g = fixture()
		await g.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'no']]),
			undefined,
			undefined,
			new Map([['call_1', { note: '😀'.repeat(4_001) }]]),
		)
		const note = (g.completed()[0] as { presentation?: { declined?: { note?: string } } })
			.presentation?.declined?.note
		expect(Array.from(note ?? '')).toHaveLength(4_000)
		expect(note).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
	})

	it('falls back to the tool name when its presentation hook throws', async () => {
		const f = fixture()
		await f.executor.executeBatch(
			response('fragile', {}),
			new Map([['call_1', 'no']]),
			undefined,
			undefined,
			new Map([['call_1', {}]]),
		)
		expect(f.completed()[0]).toMatchObject({
			presentation: { kind: 'generic', label: 'fragile', declined: {} },
		})
	})
})

describe('a call a policy refused', () => {
	it('is recorded exactly as before: an error result and no presentation', async () => {
		const f = fixture()
		await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'Refused: strict mode does not run edits.']]),
		)
		const [event] = f.completed()
		expect(event).toEqual({
			type: 'tool_completed',
			turnId: expect.any(String),
			toolUseId: 'call_1',
			toolName: 'edit',
			result: 'Error: Tool "edit" was not executed. Refused: strict mode does not run edits.',
			isError: true,
		})
		expect(event).not.toHaveProperty('presentation')
	})

	it('stays unmarked when a person declined a different call in the batch', async () => {
		const f = fixture()
		await f.executor.executeBatch(
			editCall(),
			new Map([['call_1', 'Refused by policy.']]),
			undefined,
			undefined,
			new Map([['other_call', { note: 'not this one' }]]),
		)
		expect(f.completed()[0]).not.toHaveProperty('presentation')
	})
})

describe('the review answer', () => {
	const review = (): HITLDecisionRequest => ({
		sessionId: generateSessionId(),
		type: 'tool_review',
		turnId: 'f8223c92-2ebb-4961-8f5c-51dffd77693e' as TurnId,
		checkpointId: '82267e66-99cd-4ee0-8a15-b8108f6fce73' as CheckpointId,
		toolCalls: [{ id: 'call_1', name: 'edit', input: {}, isDestructive: false }],
	})

	it('carries a host-marked No into the decision, and only then', async () => {
		const marked = createReviewHandler({
			mode: 'prompt',
			prompt: async () => ({ kind: 'reject', declined: { note: 'keep it' } }),
		})
		await expect(marked(review())).resolves.toEqual({
			action: 'reject_tools',
			feedback: DECLINED_TOOL_CALL_FEEDBACK,
			declined: { note: 'keep it' },
		})
		const unmarked = createReviewHandler({
			mode: 'prompt',
			prompt: async () => ({ kind: 'reject', feedback: 'The approval screen closed.' }),
		})
		await expect(unmarked(review())).resolves.toEqual({
			action: 'reject_tools',
			feedback: 'The approval screen closed.',
		})
	})

	it('never marks a refusal by mode, whatever the prompt would have said', async () => {
		const strict = createReviewHandler({
			mode: 'strict',
			prompt: async () => ({ kind: 'reject', declined: {} }),
		})
		const decision = await strict(review())
		expect(decision).toMatchObject({ action: 'reject_tools' })
		expect(decision).not.toHaveProperty('declined')
	})
})

describe('through a whole turn', () => {
	async function run(decision: HITLResumeDecision, withGatedCall = false) {
		const execute = vi.fn(async () => ({ success: true, output: 'edited' }))
		const tool = defineTool({
			name: 'edit',
			description: 'Replace text in a file.',
			inputSchema: z.object({ path: z.string() }),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			presentCall: (input) => ({ kind: 'generic', label: input.path }),
			execute,
		})
		const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
		const events: SessionEvent[] = []
		await drainQuery(
			{
				provider: new MockLLMProvider({
					turns: [
						{
							toolCalls: [
								{ id: 'call_1', name: 'edit', args: { path: 'app.css' } },
								...(withGatedCall ? [{ id: 'call_2', name: 'blocked', args: { path: 'x' } }] : []),
							],
						},
						{ text: 'ok' },
					],
				}),
				toolsets: [testToolset(tool, ...(withGatedCall ? [blocked] : []))],
				...(withGatedCall
					? {
							authorizationGate: {
								enabled: true,
								rules: [{ type: 'deny_by_name' as const, toolNames: ['blocked'] }],
								allowReadOnlyTools: false,
								denyDangerousPatterns: false,
								logDecisions: false,
							},
						}
					: {}),
				sessionLog,
				agentId: 'declined-agent',
				agentName: 'Declined Agent',
				messages: [{ role: 'user' as const, content: 'edit it' }],
				workingDirectory: process.cwd(),
				turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 5_000, maxIterations: 4 },
				projectId: generateProjectId(),
				sessionId: sessionLog.sessionId,
				topicId: generateTopicId(),
				tenantId: generateTenantId(),
				resumeHandler: async () => decision,
			},
			(event) => {
				events.push(event)
			},
		)
		expect(execute).not.toHaveBeenCalled()
		return events.filter((event) => event.type === 'tool_completed')
	}

	it('replays a No with the person’s words', async () => {
		const [done] = await run({
			action: 'reject_tools',
			feedback: 'The user declined this change and said: keep it',
			declined: { note: 'keep it' },
		})
		expect(done).toMatchObject({
			isError: true,
			presentation: { kind: 'generic', label: 'app.css', declined: { note: 'keep it' } },
		})
	})

	it('replays a per-call deny as the person’s too', async () => {
		const [done] = await run({
			action: 'modify_tools',
			modifications: [{ toolCallId: 'call_1', action: 'deny' }],
		})
		expect(done).toMatchObject({ presentation: { label: 'app.css', declined: {} } })
	})

	it('does not mark a call the gate refused, even when the person rejects the rest', async () => {
		const done = await run(
			{ action: 'reject_tools', feedback: 'no', declined: { note: 'keep it' } },
			true,
		)
		const byId = (id: string) => done.find((event) => event.toolUseId === id)
		expect(byId('call_1')).toMatchObject({ presentation: { declined: { note: 'keep it' } } })
		expect(byId('call_2')).toMatchObject({ isError: true })
		expect(byId('call_2')).not.toHaveProperty('presentation')
	})

	it('leaves a rejection no person made without a presentation', async () => {
		const [done] = await run({ action: 'reject_tools', feedback: 'Strict mode.' })
		expect(done).toMatchObject({ isError: true })
		expect(done).not.toHaveProperty('presentation')
	})
})
