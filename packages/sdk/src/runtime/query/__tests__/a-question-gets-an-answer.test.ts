import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { ANSWER_NOW_MESSAGE, STALL_NUDGE_MESSAGE } from '../turn/stall-monitor.js'

/**
 * A scripted loop of the kind a small model falls into when asked a question:
 * one call after another, each step saying it will answer after one more. The
 * provider replays the script and counts its requests; nothing here waits on a
 * clock, because the turn ends by the script running out of calls.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const usage = {
	promptTokens: 10,
	completionTokens: 5,
	totalTokens: 15,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** `calls` steps that each say a line and call `tool`, then one plain answer. */
function loop(tool: string, calls: number, argsFor: (i: number) => string) {
	const requests: ChatCompletionParams[] = []
	let index = 0
	const provider = {
		id: 'scripted',
		name: 'Scripted',
		requests,
		async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
			requests.push(params)
			const i = index++
			if (i >= calls) {
				yield { id: 's', delta: { content: 'the answer' } }
				yield { id: 's', delta: {}, finishReason: 'stop', usage }
				return
			}
			yield { id: 's', delta: { content: 'One last command.' } }
			yield {
				id: 's',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: `call_${i}`,
							type: 'function',
							function: { name: tool, arguments: argsFor(i) },
						},
					],
				},
			}
			yield { id: 's', delta: { toolCallEnd: { index: 0, id: `call_${i}` } } }
			yield { id: 's', delta: {}, finishReason: 'tool_calls', usage }
		},
	}
	return provider as unknown as LLMProvider & { requests: ChatCompletionParams[] }
}

async function run(provider: LLMProvider, prompt: string) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-answer-'))
	dirs.push(workingDirectory)
	return drainQuery(
		{
			provider,
			toolsets: [
				testToolset(
					{
						name: 'look',
						description: 'Read something',
						inputSchema: z.object({ n: z.number() }),
						isReadOnly: () => true,
						execute: async (input: { n: number }) => ({
							success: true,
							output: `Looked at ${input.n}.`,
						}),
					},
					{
						name: 'bash',
						description: 'Run a shell command',
						inputSchema: z.object({ n: z.number() }),
						isReadOnly: () => false,
						execute: async (input: { n: number }) => ({
							success: true,
							output: `Ran ${input.n}.`,
						}),
					},
					{
						name: 'write',
						description: 'Write a file',
						inputSchema: z.object({ n: z.number() }),
						isReadOnly: () => false,
						execute: async () => ({ success: true, output: 'ok' }),
					},
					{
						name: 'apply',
						description: 'Run a command that is not read-only',
						inputSchema: z.object({}),
						isReadOnly: () => false,
						execute: async () => ({ success: true, output: 'Done.' }),
					},
				),
			],
			turnConfig: {
				model: 'm',
				timeoutMs: 20_000,
				tokenBudget: 500_000,
				maxIterations: 20,
				maxResponseTokens: 2_000,
			},
			agentId: 'agent_a',
			agentName: 'Answer',
			messages: [createUserMessage(prompt)],
			workingDirectory,
			sessionId: 'de211f59-a613-4afc-a60b-044224636dc3' as SessionId,
			topicId: 'deff1264-c6c8-426e-b259-3409cefb8929' as TopicId,
			projectId: '013d6892-222f-41f6-84ea-144d389a3633' as ProjectId,
			tenantId: '09baa4c3-d377-42ba-80c6-b90340766578' as TenantId,
			retry: false,
		},
		() => {},
	)
}

/** The first request that carries a given progress nudge, or -1. */
function firstRequestWith(provider: { requests: ChatCompletionParams[] }, text: string) {
	return provider.requests.findIndex((r) =>
		r.messages.some(
			(m) =>
				m.role === 'user' &&
				typeof m.content === 'string' &&
				m.content.includes(text) &&
				m.source?.type === 'runtime-context' &&
				m.source.kind === 'progress-nudge',
		),
	)
}

describe('a turn that opens with a question', () => {
	it('is told to answer after six steps that only looked, and then does', async () => {
		const provider = loop('look', 12, (i) => JSON.stringify({ n: i }))
		const turn = await run(provider, 'Why did this cost so much?')
		// Six looks, then the request that follows them carries the nudge.
		expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(6)
		expect(firstRequestWith(provider, STALL_NUDGE_MESSAGE)).toBe(-1)
		expect(turn.result).toBeDefined()
	})

	it('is held to the general threshold when the message asks nothing', async () => {
		const provider = loop('look', 8, (i) => JSON.stringify({ n: i }))
		await run(provider, 'Read the files and then tell me about them.')
		expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(-1)
		expect(firstRequestWith(provider, STALL_NUDGE_MESSAGE)).toBe(-1)
	})

	it('counts the same call with the same result as no change, even from a tool that may write', async () => {
		// `apply` is not read-only, so its first run is a change; the next
		// seven give the same answer to the same input and move nothing.
		const provider = loop('apply', 12, () => '{}')
		await run(provider, 'Why is it slow?')
		expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(7)
	})

	it('does not count a shell command the policy cannot call read-only as looking', async () => {
		const provider = loop('bash', 12, (i) => JSON.stringify({ n: i }))
		await run(provider, 'Why did this cost so much?')
		expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(-1)
		expect(firstRequestWith(provider, STALL_NUDGE_MESSAGE)).toBe(-1)
	})

	it('does not count a repeated file edit with the same reply as no change', async () => {
		const provider = loop('write', 12, () => JSON.stringify({ n: 1 }))
		await run(provider, 'Why is it slow?')
		expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(-1)
	})

	it('leaves a task that holds a question mark alone', async () => {
		for (const prompt of [
			'Can you make the build pass? Run the tests, fix what fails, and re-run until green.',
			'Implement the client for https://api.example.com/v1/items?limit=10 and test it, step by step.',
		]) {
			const provider = loop('bash', 12, (i) => JSON.stringify({ n: i }))
			await run(provider, prompt)
			expect(firstRequestWith(provider, ANSWER_NOW_MESSAGE)).toBe(-1)
		}
	})

	it('is nudged again, and never forced to call a tool, when it keeps looking', async () => {
		const provider = loop('look', 18, (i) => JSON.stringify({ n: i }))
		await run(provider, 'What happened here?')
		expect(provider.requests.some((r) => r.toolChoice === 'required')).toBe(false)
		const nudgeCounts = provider.requests.map(
			(r) =>
				r.messages.filter((m) => typeof m.content === 'string' && m.content === ANSWER_NOW_MESSAGE)
					.length,
		)
		expect(Math.max(...nudgeCounts)).toBeGreaterThanOrEqual(2)
	})
})

describe('the words of the nudges', () => {
	it('offer an answer as the way out and never another command', () => {
		for (const text of [ANSWER_NOW_MESSAGE, STALL_NUDGE_MESSAGE]) {
			expect(text).not.toMatch(/run the one/i)
			expect(text.toLowerCase()).toContain('answer')
		}
		expect(ANSWER_NOW_MESSAGE).toContain('instead of running another command')
	})
})
