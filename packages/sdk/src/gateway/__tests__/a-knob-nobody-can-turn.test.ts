import type { Span } from '@opentelemetry/api'
import { describe, expect, it } from 'vitest'

import type { Agent } from '../../types/agent/core.js'
import type { AgentManagerContract } from '../../types/agent/manager.js'
import type {
	AgentTask,
	AgentTaskContext,
	AgentTaskState,
	SendMessageOptions,
} from '../../types/agent/task.js'
import type { AgentId, RunId, SessionId, TaskId, TenantId } from '../../types/ids/index.js'
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import { LocalTaskGateway } from '../local.js'

/**
 * `CreateTaskOptions.configOverrides` was declared, typed, and never read.
 *
 * `createTask` built its OWN `configOverrides` object out of `parentSpan`
 * alone, so a caller pinning a delegated run to a cheaper model, or capping
 * its iterations, got the agent's defaults and nothing to say otherwise. The
 * field type-checked, the call succeeded, and the run was not the run that was
 * asked for.
 *
 * Reachability, not behaviour: what `configOverrides` DOES once it lands on
 * `sendMessage` is the agent manager's business and is tested there. What was
 * broken is the hop.
 */

/** Records what the gateway actually asked the manager for. */
class RecordingManager implements AgentManagerContract {
	readonly sent: SendMessageOptions[] = []

	async sendMessage(options: SendMessageOptions): Promise<AgentTask> {
		this.sent.push(options)
		return {
			taskId: `task_${this.sent.length}` as TaskId,
			agentId: options.agentId,
			agent: {} as Agent<never, never>,
			childAbortController: new AbortController(),
			context: {} as AgentTaskContext,
			state: 'completed' as AgentTaskState,
			pendingMessages: [],
			createdAt: 1,
		} as AgentTask
	}

	cancel(): void {}
	cancelAll(): void {}
	async continueTask(): Promise<void> {}
	queueMessage(): void {}
	drainMessages() {
		return []
	}
	async waitForCompletion(): Promise<void> {}
	getInstance(): AgentTask | undefined {
		return undefined
	}
	listByParent(): AgentTask[] {
		return []
	}
	listActive(): AgentTask[] {
		return []
	}
	getState(): AgentTaskState | undefined {
		return undefined
	}
	on(): void {}
	off(): void {}
	cleanup(): void {}
	dispose(): void {}
}

function context(): AgentTaskContext {
	return {
		parentRunId: 'run_parent' as RunId,
		parentAgentId: 'supervisor',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: 'tnt_k' as TenantId,
		threadId: 'thd_k' as ThreadId,
		sessionId: 'ses_k' as SessionId,
		projectId: 'prj_k' as ProjectId,
		parentActor: { kind: 'agent', agentId: 'supervisor' as AgentId, tenantId: 'tnt_k' as TenantId },
	} as AgentTaskContext
}

describe('a delegated run is built with the config its caller asked for', () => {
	it('forwards configOverrides to the spawn', async () => {
		const manager = new RecordingManager()
		const gateway = new LocalTaskGateway(manager, context())

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			configOverrides: { model: 'cheap-model', maxIterations: 3 },
		})

		expect(manager.sent[0]?.configOverrides).toMatchObject({
			model: 'cheap-model',
			maxIterations: 3,
		})
	})

	it('keeps the dedicated parentSpan option winning when both name a span', async () => {
		// A caller who sets both is saying the same thing twice, and the named
		// field is the specific one for the job — so it is applied last.
		const manager = new RecordingManager()
		const gateway = new LocalTaskGateway(manager, context())
		const named = { spanContext: () => ({ traceId: 'named' }) } as unknown as Span
		const buried = { spanContext: () => ({ traceId: 'buried' }) } as unknown as Span

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			parentSpan: named,
			configOverrides: { parentSpan: buried, model: 'cheap-model' },
		})

		expect(manager.sent[0]?.configOverrides?.parentSpan).toBe(named)
		// ...and the rest of the caller's overrides survive alongside it.
		expect(manager.sent[0]?.configOverrides?.model).toBe('cheap-model')
	})

	it('still sends no configOverrides at all when the caller set neither', async () => {
		// The absent case has to stay absent: an empty object here would put
		// `configOverrides: {}` on every spawn and override nothing, which is
		// harmless until something starts reading its presence as intent.
		const manager = new RecordingManager()
		const gateway = new LocalTaskGateway(manager, context())

		await gateway.createTask({ agentId: 'worker', prompt: 'work', workingDirectory: '/tmp' })

		expect(manager.sent[0]).not.toHaveProperty('configOverrides')
	})
})
