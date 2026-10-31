import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolResultHalted } from '../../../registry/tool/screen.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { ToolManager } from '../../../toolsets/manager.js'
import type { SessionId, TenantId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import type { SessionEventDraft } from '../events.js'
import { ToolExecutor } from '../executor.js'
import { drainQuery } from '../index.js'

/**
 * `screen.ts` throws `ToolResultHalted` instead of returning it specifically
 * so `runOnce`'s generic `catch` (written for an ordinary tool bug) cannot
 * flatten it into a failed `ToolResult` the model reads and works around.
 * These tests drive the executor and a full run, not `screenToolResult` in
 * isolation: `a-tool-result-can-be-refused.test.ts` already proves the throw
 * happens; this proves it survives the trip up to the run loop.
 */

registerMock()

const TURN_ID = '5fb9bccf-9833-4de4-98ea-007296e4f93f' as TurnId
const SESSION_ID = generateSessionId()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return {
		...stub,
		child: vi.fn(() => ({ ...stub, child: vi.fn() })),
	} as unknown as Logger
}

function haltingToolManager(): ToolManager {
	return {
		execute: vi.fn(async () => {
			throw new ToolResultHalted('exfil', 'credential in output')
		}),
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		availability: vi.fn(),
	} as unknown as ToolManager
}

function response(): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: 'lookup', arguments: '{}' },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

describe('a tool result guardrail that halts, seen by the executor', () => {
	let emitted: SessionEventDraft[]

	beforeEach(() => {
		emitted = []
	})

	it('rejects the batch with ToolResultHalted rather than resolving a failed result', async () => {
		const executor = new ToolExecutor(
			{
				sessionId: SESSION_ID,
				tools: haltingToolManager(),
				turnId: TURN_ID,
				workingDirectory: '/tmp',
				permissionMode: 'auto',
				env: {},
				abortSignal: new AbortController().signal,
			},
			new ActivityStore(TURN_ID, {
				enabled: true,
				trackToolCalls: true,
				trackLlmTurns: true,
			}),
			async (e: SessionEventDraft) => {
				emitted.push(e)
			},
			makeLogger(),
		)

		await expect(executor.executeBatch(response())).rejects.toThrow(ToolResultHalted)
	})

	it('ends the turn with stopReason "error" and never asks the model to route around it', async () => {
		// Two scripted turns: a tool call, then a text answer the turn must
		// NEVER reach. Reaching it would mean the halt was read back as an
		// ordinary failed `tool_result` and the model was allowed to try
		// something else, which is what `halt` (unlike `refuse`) forbids.
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-halt-'))
		dirs.push(workingDirectory)
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [{ id: 'c1', name: 'lookup', args: {} }],
					finishReason: 'tool_calls',
				},
				{ text: 'the model must never see this turn' },
			],
		})

		const result = await drainQuery({
			provider,
			toolsets: [
				testToolset(
					defineTool({
						name: 'lookup',
						description: 'd',
						inputSchema: z.object({}),
						category: 'analysis',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						execute: async () => ({ success: true, output: 'sk-live-secret' }),
					}),
				),
			],
			toolResultGuardrails: [
				{
					name: 'exfil',
					check: () => ({
						action: 'halt' as const,
						reason: 'credential in output',
					}),
				},
			],
			turnConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 200_000,
				maxIterations: 6,
			},
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('look it up')],
			workingDirectory,
			sessionId: '345e84b8-3178-4cf4-9506-0bf9ce15b9bc' as SessionId,
			topicId: '11ec9550-2592-4bc3-9c7e-476605b16475' as TopicId,
			projectId: '0d076e45-2653-421c-8d2e-a65a5774e84d' as ProjectId,
			tenantId: 'dab321f6-0999-4bc5-8b5c-8fe545b43505' as TenantId,
		})

		expect(provider.requests.length).toBe(1)
		expect(result.stopReason).toBe('error')
	})
})
