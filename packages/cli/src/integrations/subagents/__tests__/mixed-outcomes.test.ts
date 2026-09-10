import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ChatCompletionParams,
	type LLMProvider,
	MockLLMProvider,
	ProviderError,
	ToolRegistry,
	defineTool,
	generateRunId,
	isTerminalAgentTaskState,
	mcpJsonSchemaToZod,
} from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

it.each(['tool', 'provider'])(
	'isolates %s cancellation, correction and failure across three parallel children with one receipt each',
	async (boundary) => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-mixed-agents-'))
		const parent = await subagentParentFixture(cwd)
		const foreign = generateRunId()
		const releases: Array<() => void> = []
		const requests: ChatCompletionParams[][] = [[], [], []]
		let created = 0
		let holding = false
		const runtime = await createSubagentRuntime({
			cwd,
			model: 'mock',
			resolveParent: (runId) =>
				parent.resolveParent(runId === foreign ? parent.scope.runId : runId),
			buildTools: () => {
				const tools = new ToolRegistry()
				tools.register(
					defineTool({
						name: 'hold',
						description: 'Controlled read-only observation',
						inputSchema: mcpJsonSchemaToZod({ type: 'object', properties: {} }),
						category: 'custom',
						permissions: [],
						readOnly: true,
						destructive: false,
						concurrencySafe: true,
						async execute(_input, context) {
							await new Promise<void>((resolve) => {
								holding = true
								releases[0] = resolve
								context.abortSignal.addEventListener('abort', () => resolve(), { once: true })
							})
							return { success: true, output: 'observation' }
						},
					}),
				)
				return tools
			},
			resolveResumeHandler: () => async (request) =>
				request.type === 'tool_review' ? { action: 'approve_tools' } : { action: 'continue' },
			buildProvider: () => {
				const index = created++
				const gate = new Promise<void>((resolve) => {
					releases[index] = resolve
				})
				const script = new MockLLMProvider({
					turns:
						index === 0 && boundary === 'tool'
							? [{ toolCalls: [{ id: 'hold-call', name: 'hold', args: {} }] }, { text: 'done' }]
							: [{ text: `Result ${index}` }, { text: `Corrected ${index}` }],
				})
				return {
					id: `worker-${index}`,
					name: `Worker ${index}`,
					async *chatStream(params) {
						requests[index]?.push(params)
						if (index === 0 && boundary === 'provider') holding = true
						if (index !== 0 || boundary === 'provider') await gate
						if (index === 2)
							throw new ProviderError({
								code: 'invalid_request',
								message: 'CONTROLLED_CHILD_FAILURE',
								retryable: false,
							})
						yield* script.chatStream(params)
					},
				} satisfies LLMProvider
			},
		})
		const context = {
			runId: parent.scope.runId,
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log() {},
		}
		try {
			const launches = await Promise.all(
				[0, 1, 2].map((index) =>
					runtime.agentTool.execute(
						{
							description: `Task ${index}`,
							prompt: `Only report ${index}`,
							run_in_background: true,
						},
						context,
					),
				),
			)
			expect(launches.every((result) => result.success)).toBe(true)
			await vi.waitFor(() => expect(requests.every((items) => items.length === 1)).toBe(true))
			const ids = launches.map((result) => (result.data as { task_id: string }).task_id)
			const cancelled = ids[0]!
			await vi.waitFor(() => expect(holding).toBe(true))
			const foreignCancel = await runtime.cancelAgentTool.execute(
				{ task_id: cancelled },
				{ ...context, runId: foreign },
			)
			expect(foreignCancel.success).toBe(false)
			expect(requests[0]?.[0]?.signal?.aborted).toBe(false)
			const correction = await runtime.sendMessageTool.execute(
				{ task_id: ids[1], message: 'Keep this existing task; do not start another.' },
				context,
			)
			expect(correction.success).toBe(true)
			const cancel = await runtime.cancelAgentTool.execute({ task_id: cancelled }, context)
			expect(cancel.output).toContain('Cancellation requested')
			// Cancellation targets the child tool wait after its provider receipt settled.
			expect(requests[1]?.[0]?.signal?.aborted).toBe(false)
			expect(requests[2]?.[0]?.signal?.aborted).toBe(false)
			for (const release of releases) release()
			const gateway = await runtime.gatewayForRun(parent.scope.runId)
			await vi.waitFor(
				() =>
					expect(gateway.listTasks().every((task) => isTerminalAgentTaskState(task.state))).toBe(
						true,
					),
				{ timeout: 5000 },
			)
			const list = await runtime.agentTaskListTool.execute({}, context)
			const tasks = (list.data as { tasks: Array<{ task_id: string; status: string }> }).tasks
			expect(tasks.find((task) => task.task_id === cancelled)?.status).toBe('canceled')
			expect(tasks.find((task) => task.task_id === ids[1])?.status).toBe('completed')
			expect(tasks.find((task) => task.task_id === ids[2])?.status).toBe('failed')
			const inbox = await runtime.completionInboxForRun(parent.scope.runId)
			expect(inbox.drain()).toHaveLength(3)
			expect(inbox.drain()).toHaveLength(0)
			const repeated = await runtime.cancelAgentTool.execute({ task_id: cancelled }, context)
			expect(repeated.output).toContain('already ended')
			expect(created).toBe(3)
			expect(
				requests[1]?.some((request) =>
					request.messages.some((message) =>
						String(message.content).includes('Keep this existing task; do not start another.'),
					),
				),
			).toBe(true)
			const activity = runtime.activity.getSnapshot()
			expect(activity).toHaveLength(3)
			expect(activity.find((entry) => entry.taskId === cancelled)?.status).toBe('cancelled')
			expect(activity.find((entry) => entry.taskId === ids[1])?.status).toBe('completed')
			expect(activity.find((entry) => entry.taskId === ids[2])?.status).toBe('failed')
		} finally {
			for (const release of releases) release()
			await runtime.close()
			removeTempDir(cwd)
		}
	},
)
