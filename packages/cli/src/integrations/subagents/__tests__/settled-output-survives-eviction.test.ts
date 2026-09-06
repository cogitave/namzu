import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentManager, MockLLMProvider, ToolRegistry, generateRunId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { subagentParentFixture } from '../__fixtures__/parent.js'
import { createSubagentRuntime } from '../runtime.js'

describe('retained delegated output', () => {
	const workdirs: string[] = []
	afterEach(() => {
		vi.restoreAllMocks()
		for (const workdir of workdirs.splice(0)) removeTempDir(workdir)
	})

	it('retrieves a yielded result after manager eviction without crossing parent ownership', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-delegation-eviction-'))
		workdirs.push(cwd)
		const parent = await subagentParentFixture(cwd)
		const otherRunId = generateRunId()
		const sendMessage = vi.spyOn(AgentManager.prototype, 'sendMessage')
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const completeOutput = `begin:${'x'.repeat(5_000)}:complete-tail`
		const provider = new MockLLMProvider({
			turns: [{ text: completeOutput, chunkSize: 8_000 }],
		})
		const runtime = await createSubagentRuntime({
			resolveParent: (runId) =>
				parent.resolveParent(runId === otherRunId ? parent.scope.runId : runId),
			// Pending operator input releases the initial Agent wait immediately.
			resolveWaitForInbound: () => async () => {},
			cwd,
			model: 'mock-model',
			buildTools: () => new ToolRegistry(),
			buildProvider: () => ({
				id: 'held-result',
				name: 'Held Result',
				async *chatStream(params) {
					await held
					yield* provider.chatStream(params)
				},
			}),
		})
		const context = {
			runId: parent.scope.runId,
			workingDirectory: cwd,
			abortSignal: new AbortController().signal,
			env: {},
			log() {},
		}
		try {
			const yielded = await runtime.agentTool.execute(
				{ description: 'long result', prompt: 'produce long result' },
				context,
			)
			expect(yielded.data).toMatchObject({ wait_released: 'operator_input' })
			const gateway = await runtime.gatewayForRun(parent.scope.runId)
			const taskId = gateway.listTasks()[0]!.taskId
			expect(yielded.data).toMatchObject({ task_id: taskId })
			release()
			const settled = await gateway.waitForTask(taskId)
			const inbox = await runtime.completionInboxForRun(parent.scope.runId)
			expect(inbox.drain()).toHaveLength(1)

			// Exercise the real manager's terminal eviction without a 30-second sleep.
			const manager = sendMessage.mock.contexts[0] as AgentManager
			expect(manager.getInstance(taskId)).toBeDefined()
			manager.cleanup()
			expect(manager.getInstance(taskId)).toBeUndefined()
			expect(gateway.listTasks()).toEqual([settled])

			const result = await runtime.waitForTaskTool.execute({ task_id: taskId }, context)
			expect(result.success).toBe(true)
			expect(result.output).toBe(completeOutput)
			expect(gateway.getTask(taskId)).toEqual(settled)
			expect(await gateway.waitForTask(taskId)).toEqual(settled)
			expect(provider.requests).toHaveLength(1)
			expect(sendMessage).toHaveBeenCalledTimes(1)
			expect(inbox.drain()).toEqual([])

			const foreign = await runtime.waitForTaskTool.execute(
				{ task_id: taskId },
				{ ...context, runId: otherRunId },
			)
			expect(foreign.success).toBe(false)
			expect(foreign.error).toContain('does not belong to this parent run')
			const foreignGateway = await runtime.gatewayForRun(otherRunId)
			expect(foreignGateway.getTask(taskId)).toBeUndefined()
			await expect(foreignGateway.waitForTask(taskId)).rejects.toThrow(
				'does not belong to this parent run',
			)

			await runtime.close()
			const afterClose = await runtime.waitForTaskTool.execute({ task_id: taskId }, context)
			expect(afterClose.success).toBe(false)
			expect(afterClose.output).not.toContain(completeOutput)
			expect(afterClose.error).toContain('closed')
			expect(sendMessage).toHaveBeenCalledTimes(1)
		} finally {
			release()
			await runtime.close()
		}
	})
})
