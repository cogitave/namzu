import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

describe('query stream recovery', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	it('turns an idle stream with partial tool JSON into retryable tool feedback', async () => {
		// The provider goes idle mid-tool-JSON — the exact failure the
		// truncated-tool-input recovery path exists for — then recovers on
		// the retry the runtime prompts for.
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{
							name: 'write_file',
							id: 'toolu_write_1',
							rawArguments: '{"path":"/tmp/out.md","content":"partial',
							throwAfterArguments: 'Anthropic stream idle for 90s',
						},
					],
				},
				{ text: 'Recovered after retry guidance.' },
			],
		})
		const actualWrite = vi.fn(async () => ({ success: true, output: 'should not run' }))
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
				threadId: 'thd_stream_recovery' as ThreadId,
				projectId: 'prj_stream_recovery' as ProjectId,
				tenantId: 'tnt_stream_recovery' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		expect(run.result).toBe('Recovered after retry guidance.')
		// The failed turn plus the recovery turn.
		expect(provider.requests).toHaveLength(2)
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
			'extend it with edit using insertLine',
		)
	})
})
