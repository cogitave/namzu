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

class IdleDuringToolInputProvider implements LLMProvider {
	readonly id = 'idle-during-tool-input'
	readonly name = 'Idle During Tool Input Provider'
	calls = 0

	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1

		if (this.calls === 1) {
			yield {
				id: '116b88f1-7300-4be5-a05d-f2a87105f095',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_write_1',
							type: 'function',
							function: { name: 'write_file' },
						},
					],
				},
			}
			yield {
				id: '116b88f1-7300-4be5-a05d-f2a87105f095',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_write_1',
							function: {
								arguments: '{"path":"/tmp/out.md","content":"partial',
							},
						},
					],
				},
			}
			throw new Error('Anthropic stream idle for 90s')
		}

		yield {
			id: 'efe8f849-85cf-4b94-8bc7-cad64f257419',
			delta: { content: 'Recovered after retry guidance.' },
		}
		yield {
			id: 'efe8f849-85cf-4b94-8bc7-cad64f257419',
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

class ClassifiedFailureProvider implements LLMProvider {
	readonly id = 'classified-failure'
	readonly name = 'Classified Failure Provider'

	async *chatStream(): AsyncIterable<StreamChunk> {
		yield await Promise.reject(
			new ProviderRequestError({
				kind: 'throttle',
				providerId: 'classified-failure',
				status: 429,
				retryAfterMs: 2000,
				detail: 'rate limit reached for this organization',
			}),
		)
	}
}

/** Two calls on one tool-call index: a stream the turn loop refuses. */
class IndexReusingProvider implements LLMProvider {
	readonly id = 'index-reusing'
	readonly name = 'Index Reusing Provider'

	async *chatStream(): AsyncIterable<StreamChunk> {
		yield {
			id: 'r',
			delta: {
				toolCalls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'write_file' } }],
			},
		}
		yield {
			id: 'r',
			delta: {
				toolCalls: [{ index: 0, id: 'call_b', type: 'function', function: { name: 'write_file' } }],
			},
		}
		yield { id: 'r', delta: {}, finishReason: 'tool_calls', usage: ZERO_USAGE }
	}
}

describe('query stream recovery', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('retains partial-tool recovery evidence but stops spending without a final usage receipt', async () => {
		const provider = new IdleDuringToolInputProvider()
		const actualWrite = vi.fn(async () => ({
			success: true,
			output: 'should not run',
		}))
		const tools = testToolset({
			name: 'write_file',
			description: 'write a file',
			inputSchema: z.object({
				path: z.string(),
				content: z.string(),
			}),
			largeStringArguments: { content: 12_000 },
			truncatedInputHint: 'Write a long file in sections.',
			execute: actualWrite,
		})
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-stream-recovery-'))
		workdirs.push(workingDirectory)
		const events: SessionEvent[] = []

		const run = await drainQuery(
			{
				provider,
				toolsets: [tools],
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 3,
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

		expect(run.status).toBe('completed')
		expect(run.result).toBeUndefined()
		expect(run.stopReason).toBe('token_budget')
		expect(run.budget).toMatchObject({ poisoned: true, inFlightRequests: 1 })
		expect(provider.calls).toBe(1)
		expect(actualWrite).not.toHaveBeenCalled()

		expect(events.some((event) => event.type === 'turn_failed')).toBe(false)
		expect(
			events.some(
				(event) =>
					event.type === 'tool_input_completed' &&
					event.inputTruncated === true &&
					event.inputError?.reason === 'truncated' &&
					event.inputError.finishReason === undefined &&
					event.partialArguments === '{"path":"/tmp/out.md","content":"partial' &&
					JSON.stringify(event.input) === '{}',
			),
		).toBe(true)
		expect(JSON.stringify(events)).not.toContain('__namzuTruncated')

		const completedTool = events.find(
			(event) => event.type === 'tool_completed' && event.toolUseId === 'toolu_write_1',
		)
		expect(completedTool).toMatchObject({
			type: 'tool_completed',
			toolName: 'write_file',
			isError: true,
		})
		// The stream died, so the call was cut off — and the tool's own
		// declarations, not a fixed file-tool recipe, say what to do about it.
		expect(completedTool?.type === 'tool_completed' ? completedTool.result : '').toBe(
			'Error: The call to "write_file" was cut off: the response stream ended after 40 characters of its arguments, before they were complete. The tool was NOT executed. Send it again with less in one call: keep `content` under 12000 characters. Write a long file in sections.',
		)
	})

	it('pauses on a stream that broke tool-call framing, naming the violation, and runs nothing', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-framing-'))
		workdirs.push(workingDirectory)
		const actualWrite = vi.fn(async () => ({ success: true, output: 'should not run' }))
		const tools = testToolset({
			name: 'write_file',
			description: 'write a file',
			inputSchema: z.object({ path: z.string() }),
			execute: actualWrite,
		})

		const run = await drainQuery(
			{
				provider: new IndexReusingProvider(),
				retry: { maxRetries: 0 },
				toolsets: [tools],
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 2,
					maxResponseTokens: 256,
				},
				agentId: 'agent_test',
				agentName: 'Test Agent',
				messages: [createUserMessage('write two files')],
				workingDirectory,
				sessionId: '0f0c4a52-3f7e-4b0c-9a51-6f3de1b7a2c4' as SessionId,
				topicId: 'b8f1e0a4-5c2d-4e7b-8a9f-1d2c3b4a5e6f' as TopicId,
				projectId: 'c7d6e5f4-a3b2-4c1d-9e8f-7a6b5c4d3e2f' as ProjectId,
				tenantId: 'd1e2f3a4-b5c6-4d7e-8f9a-0b1c2d3e4f5a' as TenantId,
			},
			() => {},
		)

		expect(run.stopReason).toBe('paused')
		expect(run.lastProviderError).toEqual({
			kind: 'server',
			providerId: 'index-reusing',
			detail: 'the stream reused tool-call index 0 for call "call_b" while call "call_a" held it',
		})
		expect(actualWrite).not.toHaveBeenCalled()
	})

	it('preserves classified provider metadata through the primary turn boundary', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-provider-error-'))
		workdirs.push(workingDirectory)
		const events: SessionEvent[] = []

		const run = await drainQuery(
			{
				provider: new ClassifiedFailureProvider(),
				// Retry off: this pins METADATA at the boundary, and a throttle
				// is genuinely retryable — leaving retry on would spend the turn's
				// whole timeout backing off and settle it as a timeout instead,
				// testing the retry policy rather than the thing named here.
				retry: { maxRetries: 0 },
				toolsets: [],
				turnConfig: {
					model: 'mock-model',
					timeoutMs: 5_000,
					tokenBudget: 100_000,
					maxIterations: 1,
					maxResponseTokens: 256,
				},
				agentId: 'agent_test',
				agentName: 'Test Agent',
				messages: [createUserMessage('fail with classified metadata')],
				workingDirectory,
				sessionId: '71d49427-a03e-4e5a-a865-3287786a3b77' as SessionId,
				topicId: '14371173-7de5-4506-b5d4-a26b3d3f8a10' as TopicId,
				projectId: 'cf5fdd6c-a93d-4e2e-9e70-76aba7aeb9a6' as ProjectId,
				tenantId: 'fb80e705-99b1-4aa1-b1ba-c42dda4eea5c' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		// A throttle is recoverable, so the turn pauses; the metadata rides
		// the pause exactly as it would ride a failure.
		expect(run.stopReason).toBe('paused')
		// `detail` rides along with the classification. Without it a host
		// rendering this metadata knows a request was rejected but not why, and
		// has to go re-parse the message string — which is the re-parsing this
		// structured field exists to avoid.
		expect(run.lastProviderError).toEqual({
			kind: 'throttle',
			providerId: 'classified-failure',
			status: 429,
			retryAfterMs: 2000,
			detail: 'rate limit reached for this organization',
		})
		expect(events.find((event) => event.type === 'turn_paused')).toMatchObject({
			type: 'turn_paused',
			providerError: run.lastProviderError,
		})
	})
})
