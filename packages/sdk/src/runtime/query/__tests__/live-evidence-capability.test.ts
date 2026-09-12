import { expect, it } from 'vitest'
import { z } from 'zod'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import type { ToolContext } from '../../../types/tool/index.js'
import {
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

it.each([false, true])(
	'keeps live capture invocation-bound when cancellation during capture is %s',
	async (cancelDuringCapture) => {
		const caller = new AbortController()
		const store = new InMemoryRunStore()
		const runStore = cancelDuringCapture
			? Object.assign(store, {
					captureTextEvidence: async () => {
						caller.abort(new Error('operator cancelled during capture'))
						return undefined
					},
				})
			: store
		let capture: ToolContext['captureRunEvidence']
		let returned = false
		let refused = false
		const tools = new ToolRegistry()
		tools.register({
			name: 'capture_evidence',
			description: 'Read the current invocation boundary.',
			inputSchema: z.object({}),
			execute: async (_input, context) => {
				capture = context.captureRunEvidence
				try {
					expect(await capture!()).toBeUndefined()
					returned = true
					return { success: true, output: 'This backend has no retained text capability.' }
				} catch (error) {
					refused = true
					throw error
				}
			},
		})
		const run = await drainQuery({
			runId: generateRunId(),
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'capture', name: 'capture_evidence', args: {} }] },
					{ text: 'Done.' },
				],
			}),
			tools,
			runStore,
			checkpointStore: new InMemoryCheckpointStore(),
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			workingDirectory: process.cwd(),
			agentId: 'capture-check',
			agentName: 'Capture check',
			messages: [{ role: 'user', content: 'Inspect the recorded boundary.' }],
			signal: caller.signal,
			runConfig: {
				model: 'mock',
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				permissionMode: 'auto',
			},
		})
		expect(run.status).toBe(cancelDuringCapture ? 'cancelled' : 'completed')
		expect(returned).toBe(!cancelDuringCapture)
		expect(refused).toBe(cancelDuringCapture)
		await expect(capture!()).rejects.toThrow(
			cancelDuringCapture ? 'cancelled' : 'active invocation',
		)
	},
)
