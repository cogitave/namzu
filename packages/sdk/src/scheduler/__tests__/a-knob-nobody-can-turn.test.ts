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
import type { RunEventListener } from '../../types/run/events.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { LocalTaskScheduler } from '../local.js'

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

	async sendMessage(
		options: SendMessageOptions,
		_context?: AgentTaskContext,
		_listener?: RunEventListener,
	): Promise<AgentTask> {
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

class EventManager extends RecordingManager {
	constructor(private readonly events: readonly Parameters<RunEventListener>[0][]) {
		super()
	}

	override async sendMessage(
		options: SendMessageOptions,
		_context?: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask> {
		for (const event of this.events) await listener?.(event)
		return await super.sendMessage(options)
	}
}

function context(): AgentTaskContext {
	return {
		parentRunId: 'run_parent' as RunId,
		parentAgentId: 'supervisor',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: 'tnt_k' as TenantId,
		topicId: 'top_k' as TopicId,
		sessionId: 'ses_k' as SessionId,
		projectId: 'prj_k' as ProjectId,
		parentActor: {
			kind: 'agent',
			agentId: 'supervisor' as AgentId,
			tenantId: 'tnt_k' as TenantId,
		},
	} as AgentTaskContext
}

describe('a delegated run is built with the config its caller asked for', () => {
	it('forwards configOverrides to the spawn', async () => {
		const manager = new RecordingManager()
		const gateway = new LocalTaskScheduler(manager, context())

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
		const gateway = new LocalTaskScheduler(manager, context())
		const named = {
			spanContext: () => ({ traceId: 'named' }),
		} as unknown as Span
		const buried = {
			spanContext: () => ({ traceId: 'buried' }),
		} as unknown as Span

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
		const gateway = new LocalTaskScheduler(manager, context())

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
		})

		expect(manager.sent[0]).not.toHaveProperty('configOverrides')
	})
})

describe('a task-specific event observer', () => {
	const events = [
		{ type: 'run_started' as const, runId: 'run_child' as RunId },
		{
			type: 'iteration_started' as const,
			runId: 'run_child' as RunId,
			iteration: 1,
		},
	]

	it('receives this task events alongside the scheduler observer', async () => {
		const global: string[] = []
		const task: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events), context(), (event) => {
			global.push(event.type)
		})

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: (event) => {
				task.push(event.type)
			},
		})

		expect(global).toEqual(['run_started', 'iteration_started'])
		expect(task).toEqual(global)
	})

	it('does not let one observer suppress the other or the child', async () => {
		const task: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events), context(), () => {
			throw new Error('broken global observer')
		})

		const handle = await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: (event) => {
				task.push(event.type)
			},
		})

		expect(handle.state).toBe('completed')
		expect(task).toEqual(['run_started', 'iteration_started'])
	})

	it('does not let one observer mutate what the other observer sees', async () => {
		const task: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events), context(), (event) => {
			;(event as { type: string }).type = 'forged'
			throw new Error('broken and mutating global observer')
		})

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: (event) => {
				task.push(event.type)
			},
		})

		expect(task).toEqual(['run_started', 'iteration_started'])
	})

	it('delivers once when both scopes intentionally share one observer', async () => {
		const seen: string[] = []
		const observer: RunEventListener = (event) => {
			seen.push(event.type)
		}
		const gateway = new LocalTaskScheduler(new EventManager(events), context(), observer)

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: observer,
		})

		expect(seen).toEqual(['run_started', 'iteration_started'])
	})

	it('keeps an async observer stream ordered without backpressuring the child', async () => {
		let releaseFirst: (() => void) | undefined
		const first = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const seen: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events), context())

		const handle = await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: async (event) => {
				seen.push(`start:${event.type}`)
				if (event.type === 'run_started') await first
				seen.push(`end:${event.type}`)
			},
		})

		// The child already returned even though its observer is still waiting.
		expect(handle.state).toBe('completed')
		expect(seen).toEqual(['start:run_started'])
		releaseFirst?.()
		await first
		await new Promise<void>((resolve) => setTimeout(resolve, 0))
		expect(seen).toEqual([
			'start:run_started',
			'end:run_started',
			'start:iteration_started',
			'end:iteration_started',
		])
	})

	it('continues an observer stream after an async rejection', async () => {
		const seen: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events), context())

		await gateway.createTask({
			agentId: 'worker',
			prompt: 'work',
			workingDirectory: '/tmp',
			onEvent: async (event) => {
				seen.push(event.type)
				if (event.type === 'run_started') throw new Error('export failed')
			},
		})
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(seen).toEqual(['run_started', 'iteration_started'])
	})

	it('does not let one task observer delay another task observer', async () => {
		let releaseSlow: (() => void) | undefined
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve
		})
		const fastSeen: string[] = []
		const gateway = new LocalTaskScheduler(new EventManager(events.slice(0, 1)), context())

		await gateway.createTask({
			agentId: 'slow-worker',
			prompt: 'slow',
			workingDirectory: '/tmp',
			onEvent: async () => slow,
		})
		await gateway.createTask({
			agentId: 'fast-worker',
			prompt: 'fast',
			workingDirectory: '/tmp',
			onEvent: (event) => {
				fastSeen.push(event.type)
			},
		})
		await new Promise<void>((resolve) => setTimeout(resolve, 0))

		expect(fastSeen).toEqual(['run_started'])
		releaseSlow?.()
	})
})
