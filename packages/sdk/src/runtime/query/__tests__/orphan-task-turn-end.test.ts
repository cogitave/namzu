import { rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { TaskGateway, TaskHandle } from '../../../types/agent/gateway.js'
import type { SessionId, TaskId, TenantId } from '../../../types/ids/index.js'
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

/** Ends its turn with plain text on the first (and only) call. */
class SingleTurnProvider implements LLMProvider {
	readonly id = 'single-turn'
	readonly name = 'Single Turn Provider'
	calls = 0

	async *chatStream(): AsyncIterable<StreamChunk> {
		this.calls += 1
		yield {
			id: `msg_${this.calls}`,
			delta: { content: 'Final answer.' },
		}
		yield {
			id: `msg_${this.calls}`,
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

/**
 * Gateway that permanently reports one running task. Every dispatch
 * tool is blocking, so a running task at end-of-turn is an orphan —
 * there is no notification producer that could ever deliver its
 * result (the listener was removed in dc16d58). The run must NOT
 * busy-wait on it.
 */
function orphanTaskGateway(): TaskGateway {
	const handle: TaskHandle = {
		taskId: 'task_orphan' as TaskId,
		agentId: 'agent_worker',
		state: 'running',
		createdAt: Date.now(),
	}
	return {
		createTask: async () => handle,
		waitForTask: () => new Promise<TaskHandle>(() => {}),
		continueTask: async () => {},
		cancelTask: () => {},
		getTask: () => handle,
		listTasks: () => [handle],
		onTaskCompleted: () => () => {},
	}
}

describe('end of turn with running agent tasks', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	// Regression: the loop used to poll `pendingNotifications` every
	// 250ms for up to `runConfig.timeoutMs` (120s default) whenever the
	// turn ended while the gateway still listed a running task — but
	// nothing has pushed onto that queue since dc16d58 removed the
	// onTaskCompleted producer, so the wait always injected nothing and
	// the run hung for minutes. The vitest per-test timeout is the
	// hang detector here: with the busy-wait present this test times
	// out instead of completing.
	it('ends the run promptly instead of busy-waiting on orphan tasks', async () => {
		const provider = new SingleTurnProvider()
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-orphan-task-'))
		workdirs.push(workingDirectory)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider,
				tools: new ToolRegistry(),
				runConfig: {
					model: 'mock-model',
					// Deliberately longer than the vitest timeout: the old
					// code waited min(timeoutMs, …) polling the dead queue.
					timeoutMs: 120_000,
					tokenBudget: 100_000,
					maxIterations: 3,
					maxResponseTokens: 256,
				},
				agentId: 'agent_test',
				agentName: 'Test Agent',
				messages: [createUserMessage('do the thing')],
				workingDirectory,
				taskGateway: orphanTaskGateway(),
				sessionId: 'ses_orphan_task' as SessionId,
				threadId: 'thd_orphan_task' as ThreadId,
				projectId: 'prj_orphan_task' as ProjectId,
				tenantId: 'tnt_orphan_task' as TenantId,
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		expect(run.stopReason).toBe('end_turn')
		expect(run.result).toBe('Final answer.')
		// One turn only — no futile re-invocation loop on the orphan.
		expect(provider.calls).toBe(1)
		expect(events.some((event) => event.type === 'run_failed')).toBe(false)
	}, 10_000)
})
