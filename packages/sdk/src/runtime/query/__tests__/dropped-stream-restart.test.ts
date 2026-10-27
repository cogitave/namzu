import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ProviderRequestError } from '../../../provider/errors.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { drainQuery } from '../index.js'

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const dropped = () =>
	new ProviderRequestError({
		kind: 'network',
		providerId: 'dropping',
		detail: 'the connection closed before the response finished',
	})

/** A call whose arguments are still being written when the connection goes. */
const halfWrittenCall = (): StreamChunk[] => [
	{
		id: 'r',
		delta: {
			toolCalls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_file' } }],
		},
	},
	{
		id: 'r',
		delta: {
			toolCalls: [
				{
					index: 0,
					id: 'call_a',
					function: { arguments: '{"path":"/tmp/out.md","content":"half of a long scr' },
				},
			],
		},
	},
]

const wholeCall = (): StreamChunk[] => [
	{
		id: 'r',
		delta: {
			toolCalls: [
				{
					index: 0,
					id: 'call_b',
					type: 'function',
					function: { name: 'write_file', arguments: '{"path":"/tmp/out.md","content":"all"}' },
				},
			],
		},
	},
	{ id: 'r', delta: {}, finishReason: 'tool_calls', usage: ZERO_USAGE },
]

/** Attempt N plays `attempts[N]`; an attempt that ends in `'drop'` throws a network failure. */
class DroppingProvider implements LLMProvider {
	readonly id = 'dropping'
	readonly name = 'Dropping'
	calls = 0
	readonly seen: unknown[][] = []
	constructor(private readonly attempts: ReadonlyArray<readonly (StreamChunk | 'drop')[]>) {}

	async *chatStream(params: { messages: unknown[] }): AsyncIterable<StreamChunk> {
		this.seen.push([...params.messages])
		const step = this.attempts[Math.min(this.calls, this.attempts.length - 1)] ?? []
		this.calls += 1
		for (const item of step) {
			if (item === 'drop') throw dropped()
			yield item
		}
	}
}

describe('a stream that drops while a tool call is being written', () => {
	let workdirs: string[] = []
	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function run(provider: DroppingProvider, maxRetries: number) {
		const write = vi.fn(async () => ({ success: true, output: 'written' }))
		const tools = testToolset({
			name: 'write_file',
			description: 'write a file',
			inputSchema: z.object({ path: z.string(), content: z.string() }),
			largeStringArguments: { content: 12_000 },
			truncatedInputHint: 'Write a long file in sections.',
			execute: write,
		})
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-dropped-stream-'))
		workdirs.push(workingDirectory)
		const events: SessionEvent[] = []
		const result = await drainQuery(
			{
				provider,
				// No wait between tries: nothing here depends on how long a wait takes.
				retry: { maxRetries, initialDelayMs: 0, maxDelayMs: 0 },
				toolsets: [tools],
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 0,
					maxIterations: 2,
					maxResponseTokens: 256,
				},
				agentId: 'agent_test',
				agentName: 'Test Agent',
				messages: [createUserMessage('write the file')],
				workingDirectory,
				sessionId: 'e86cd939-0ef9-4824-a4fe-6b9e851c1974' as SessionId,
				topicId: 'cc9902c4-9754-4cbe-b4b7-c33d033766be' as TopicId,
				projectId: '38151cce-7294-4000-b702-bf368837c731' as ProjectId,
				tenantId: '3656c057-2bfd-4643-9a40-b456338506a7' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)
		return { result, events, write }
	}

	it('sends the same request again and the model never sees the half-written call', async () => {
		const provider = new DroppingProvider([
			[...halfWrittenCall(), 'drop'],
			[...wholeCall()],
			[
				{ id: 'x', delta: { content: 'Done.' } },
				{ id: 'x', delta: {}, finishReason: 'stop', usage: ZERO_USAGE },
			],
		])
		const { result, events, write } = await run(provider, 3)

		expect(result.stopReason).not.toBe('paused')
		expect(write).toHaveBeenCalledTimes(1)
		// The resent request is the same request: the same messages, nothing added.
		expect(provider.seen[1]).toEqual(provider.seen[0])
		expect(events.filter((e) => e.type === 'provider_retry')).toMatchObject([
			{ attempt: 1, code: 'network', restart: true },
		])
		// No call was answered with a cut-off message.
		const answers = events.filter((e) => e.type === 'tool_completed')
		expect(answers).toHaveLength(1)
		expect(JSON.stringify(answers)).not.toContain('cut off')
		expect(JSON.stringify(events)).not.toContain('connection dropped')
	})

	it('pauses once the attempts are spent, and says nothing to the model', async () => {
		const provider = new DroppingProvider([[...halfWrittenCall(), 'drop']])
		const { result, events, write } = await run(provider, 2)

		expect(provider.calls).toBe(3)
		expect(result.stopReason).toBe('paused')
		expect(write).not.toHaveBeenCalled()
		expect(events.some((e) => e.type === 'tool_completed')).toBe(false)
		expect(events.find((e) => e.type === 'turn_paused')).toMatchObject({
			providerError: { kind: 'network' },
		})
	})

	it('records a text answer that was cut as a partial message with the refusal stop and pauses', async () => {
		const provider = new DroppingProvider([
			[{ id: 'x', delta: { content: 'The answer begins' } }, 'drop'],
		])
		const { result, events } = await run(provider, 1)

		expect(result.stopReason).toBe('paused')
		// Text is not restarted by default: the request is not sent a second time.
		expect(provider.calls).toBe(1)
		const completed = events.filter((e) => e.type === 'message_completed')
		expect(completed).toMatchObject([{ stopReason: 'refusal', content: 'The answer begins' }])
		expect(events.find((e) => e.type === 'turn_paused')).toMatchObject({
			providerError: { kind: 'network' },
		})
	})
})
