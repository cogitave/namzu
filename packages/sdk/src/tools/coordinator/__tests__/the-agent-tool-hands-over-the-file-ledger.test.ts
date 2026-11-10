import { describe, expect, it } from 'vitest'

import type { TaskHandle, TaskScheduler } from '../../../types/agent/scheduler.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { buildAgentTool } from '../agent.js'

/**
 * A script the parent wrote and a child runs: the child's classifier can only
 * read it as the session's own when the child shares the parent's file ledger.
 * The delegation tool is where the ledger leaves the parent's turn.
 */
const taskId = '4537218c-2f1d-4794-a483-1f5223f62928' as TaskId
const handle: TaskHandle = { taskId, agentId: 'worker', state: 'running', createdAt: 0 }

describe('the agent tool', () => {
	it('hands the turn’s file ledger to the child it spawns', async () => {
		const spawned: Record<string, unknown>[] = []
		const gateway = {
			async createTask(options: Record<string, unknown>) {
				spawned.push(options)
				return handle
			},
			async waitForTask() {
				return { ...handle, state: 'failed' as const }
			},
			async continueTask() {},
			cancelTask() {},
			getTask() {
				return handle
			},
			listTasks() {
				return [handle]
			},
			onTaskCompleted() {
				return () => {}
			},
		} as unknown as TaskScheduler
		const tracker = createFileReadTracker()
		const context: ToolContext = {
			sessionId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
			turnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as never,
			workingDirectory: '/tmp/test',
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			fileReadTracker: tracker,
		}
		const tool = buildAgentTool({
			gateway,
			workingDirectory: '/tmp/test',
			allowedAgentIds: ['worker'],
		})
		await tool.execute({ description: 'd', prompt: 'p', subagent_type: 'worker' }, context)
		expect((spawned[0]?.configOverrides as { fileReadTracker?: unknown })?.fileReadTracker).toBe(
			tracker,
		)
	})
})
