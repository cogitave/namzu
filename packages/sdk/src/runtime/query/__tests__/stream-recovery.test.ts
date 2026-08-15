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
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
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
				id: 'msg_1',
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
				id: 'msg_1',
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
			id: 'msg_2',
			delta: { content: 'Recovered after retry guidance.' },
		}
		yield {
			id: 'msg_2',
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

	it('turns an idle stream with partial tool JSON into retryable tool feedback', async () => {
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
				sessionId: 'ses_stream_recovery' as SessionId,
				topicId: 'top_stream_recovery' as ThreadId,
				projectId: 'prj_stream_recovery' as ProjectId,
				tenantId: 'tnt_stream_recovery' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		expect(run.result).toBe('Recovered after retry guidance.')
		expect(provider.calls).toBe(2)
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
				sessionId: 'ses_provider_error' as SessionId,
				topicId: 'top_provider_error' as ThreadId,
				projectId: 'prj_provider_error' as ProjectId,
				tenantId: 'tnt_provider_error' as TenantId,
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
