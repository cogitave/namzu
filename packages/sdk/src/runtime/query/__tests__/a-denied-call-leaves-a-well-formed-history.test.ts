import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * A model asked for a tool the operator had denied, was told so, and then
 * came back with nothing to say. That empty reply starts a closing request.
 * Chat Completions endpoints reject an assistant message with neither content
 * nor tool calls, so what the loop hands the provider at that point matters:
 * the denied call must still be answered, with a plain sentence tied to its
 * id, and every tool message must follow the assistant entry that made its
 * call. The drivers decide how an empty reply looks on their own wire.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const fetches = (...ids: string[]): MockTurn => ({
	toolCalls: ids.map((id) => ({ id, name: 'web_fetch', args: { url: 'https://example.test' } })),
	finishReason: 'tool_calls',
})

async function run(turns: MockTurn[]) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-denied-'))
	dirs.push(workingDirectory)
	const executions: string[] = []
	const sent: Message[][] = []
	const provider = new MockLLMProvider({
		turns,
		onRequest: (params) => {
			sent.push(structuredClone(params.messages) as Message[])
		},
	})
	const result = await drainQuery({
		provider,
		toolsets: [
			testToolset(
				defineTool({
					name: 'web_fetch',
					description: 'fetch a page',
					inputSchema: z.object({ url: z.string() }),
					category: 'network',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async () => {
						executions.push('ran')
						return { success: true, output: 'a page' }
					},
				}),
			),
		],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 8 },
		authorizationGate: {
			enabled: true,
			rules: [{ type: 'deny_by_name' as const, toolNames: ['web_fetch'] }],
			allowReadOnlyTools: false,
			denyDangerousPatterns: false,
			logDecisions: false,
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
	return { result, sent, executions }
}

/** Every tool message follows an assistant entry that made its call; every call is answered. */
function expectPaired(messages: readonly Message[]): void {
	let open: Set<string> | undefined
	let answered = new Set<string>()
	const closeOpen = () => {
		if (open) expect([...open].filter((id) => !answered.has(id))).toEqual([])
	}
	for (const message of messages) {
		if (message.role === 'tool') {
			expect(open?.has(message.toolCallId)).toBe(true)
			answered.add(message.toolCallId)
			continue
		}
		closeOpen()
		open = undefined
		answered = new Set()
		if (message.role === 'assistant' && message.toolCalls?.length) {
			open = new Set(message.toolCalls.map((call) => call.id))
		}
	}
	closeOpen()
}

describe('a denied call leaves a well-formed history', () => {
	it('answers a denied call with a plain sentence tied to its id, and the next request stays paired', async () => {
		const { sent, executions } = await run([fetches('c1'), { text: 'I will do it another way.' }])
		expect(executions).toEqual([])
		expect(sent).toHaveLength(2)
		const second = sent[1] as Message[]
		const call = second.find((m) => m.role === 'assistant' && m.toolCalls?.length)
		expect(call).toMatchObject({ toolCalls: [{ id: 'c1', function: { name: 'web_fetch' } }] })
		const result = second.find((m) => m.role === 'tool')
		expect(result).toMatchObject({ toolCallId: 'c1', isError: true })
		expect(typeof result?.content).toBe('string')
		expect(result?.content as string).toMatch(/was not executed.*refused for this turn/)
		expect(result?.content as string).not.toMatch(/undefined|\[object|\{"/)
		for (const request of sent) expectPaired(request)
	})

	it('answers two parallel denied calls, each with its own result', async () => {
		const { sent } = await run([fetches('c1', 'c2'), { text: 'done' }])
		const second = sent[1] as Message[]
		expect(
			second.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId),
		).toEqual(['c1', 'c2'])
		for (const request of sent) expectPaired(request)
	})

	it('keeps every request paired when the reply after the denial is empty', async () => {
		// An empty reply is a completion with no text and no calls; the loop then
		// asks once more for a closing answer.
		const { sent, result } = await run([
			fetches('c1', 'c2'),
			{ finishReason: 'stop' },
			{ text: 'closing' },
		])
		expect(sent.length).toBeGreaterThanOrEqual(3)
		for (const request of sent) expectPaired(request)
		expect(result.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'closing' })
		// The empty reply stays in the stored history but is not handed to the
		// provider, in the closing request or in any later one.
		for (const request of sent) {
			expect(
				request.filter((m) => m.role === 'assistant' && !m.content && !(m.toolCalls?.length ?? 0)),
			).toEqual([])
		}
		expect(
			result.messages.some((m) => m.role === 'assistant' && !m.content && !m.toolCalls?.length),
		).toBe(true)
	})
})
