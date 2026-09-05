import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ProviderRequestError } from '../../../provider/errors.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
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
		const tools = new ToolRegistry()
		tools.register({
			name: 'write_file',
			description: 'write a file',
			inputSchema: z.object({
				path: z.string(),
				content: z.string(),
			}),
			execute: actualWrite,
		})
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-stream-recovery-'))
		workdirs.push(workingDirectory)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider,
				tools,
				runConfig: {
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

		expect(events.some((event) => event.type === 'run_failed')).toBe(false)
		expect(
			events.some(
				(event) =>
					event.type === 'tool_input_completed' &&
					event.inputTruncated === true &&
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
		expect(completedTool?.type === 'tool_completed' ? completedTool.result : '').toContain(
			'call was cut off',
		)
		expect(completedTool?.type === 'tool_completed' ? completedTool.result : '').toContain(
			'advance that marker with bounded exact edit calls',
		)
	})

	it('preserves classified provider metadata through the primary run boundary', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-provider-error-'))
		workdirs.push(workingDirectory)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider: new ClassifiedFailureProvider(),
				// Retry off: this pins METADATA at the boundary, and a throttle
				// is genuinely retryable — leaving retry on would spend the run's
				// whole timeout backing off and settle it as a timeout instead,
				// testing the retry policy rather than the thing named here.
				retry: { maxRetries: 0 },
				tools: new ToolRegistry(),
				runConfig: {
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

		expect(run.status).toBe('failed')
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
		expect(events.find((event) => event.type === 'run_failed')).toMatchObject({
			type: 'run_failed',
			providerError: run.lastProviderError,
		})
	})
})
