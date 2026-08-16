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
import type { ProjectId, ThreadId } from '../../types/session/ids.js'
import { LocalTaskScheduler } from '../local.js'

/**
 * A child that spoke before its own spawn resolved killed the launch.
 *
 * The progress tee handed to `sendMessage` read `task.taskId` — the `const`
 * that the very same `await` assigns. So any run event emitted by the child
 * before `sendMessage` returned reached that line inside the temporal dead
 * zone and threw `Cannot access 'task' before initialization`, taking the whole
 * `create_task` down with it.
 *
 * It survived review and a full unit suite because a single sequential launch
 * usually resolves before the child says anything. A CONCURRENT fan-out does
 * not — and that is the shape `create_task`'s own description tells the model
 * to use. Observed live on the published package: four launches from one turn,
 * three dead.
 */

const RUN = 'run_tee' as RunId

/** Emits a run event DURING the spawn, before it resolves. */
class TalksDuringSpawn implements AgentManagerContract {
	/** Kept so a test can make the child speak AFTER the spawn resolved too. */
	private lastListener?: RunEventListener

	constructor(private readonly emitsBeforeResolve: number) {}

	/** The child says something once the caller holds its handle. */
	speakNow(): void {
		this.lastListener?.({ type: 'iteration_started', runId: RUN, iteration: 99 } as never)
	}

	async sendMessage(
		options: SendMessageOptions,
		_context: AgentTaskContext,
		listener?: RunEventListener,
	): Promise<AgentTask> {
		this.lastListener = listener
		// The child is alive and streaming before the caller holds its handle.
		for (let i = 0; i < this.emitsBeforeResolve; i += 1) {
			listener?.({ type: 'iteration_started', runId: RUN, iteration: i } as never)
		}
		await Promise.resolve()
		return {
			taskId: 'task_spoke_early' as TaskId,
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
		parentRunId: RUN,
		parentAgentId: 'supervisor',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: 'tnt_t' as TenantId,
		topicId: 'top_t' as ThreadId,
		sessionId: 'ses_t' as SessionId,
		projectId: 'prj_t' as ProjectId,
		parentActor: { kind: 'agent', agentId: 'supervisor' as AgentId, tenantId: 'tnt_t' as TenantId },
	} as AgentTaskContext
}

describe('a launch survives a child that speaks before the spawn resolves', () => {
	it('does not throw when an event arrives mid-spawn', async () => {
		const gateway = new LocalTaskScheduler(new TalksDuringSpawn(3), context())
		// The listener is what makes this reproduce, and its absence is what
		// made the bug invisible for so long: with no progress subscriber the
		// loop body never runs, so `task.taskId` is never evaluated and the
		// dead zone is never entered. `create_task` attaches one for the idle
		// bound on every blocking launch, which is why it bit in production and
		// not in any test.
		gateway.onTaskProgress?.(() => {})

		await expect(
			gateway.createTask({ agentId: 'worker', prompt: 'go', workingDirectory: '/tmp' }),
		).resolves.toMatchObject({ taskId: 'task_spoke_early' })
	})

	it('still forwards those events to the host listener', async () => {
		// The tee is what broke, not the forwarding. A host watching the child
		// must not lose its early events to this fix.
		const seen: string[] = []
		const gateway = new LocalTaskScheduler(new TalksDuringSpawn(3), context(), (e) => {
			seen.push(e.type)
		})

		await gateway.createTask({ agentId: 'worker', prompt: 'go', workingDirectory: '/tmp' })

		expect(seen).toEqual(['iteration_started', 'iteration_started', 'iteration_started'])
	})

	it('reports progress once the task has an id to report it against', async () => {
		// Before the id exists nothing is waiting on the task — the caller does
		// not hold the handle yet — so silence there is correct. What must work
		// is everything after.
		const manager = new TalksDuringSpawn(1)
		const gateway = new LocalTaskScheduler(manager, context())
		const progressed: TaskId[] = []
		gateway.onTaskProgress?.((id) => progressed.push(id))

		await gateway.createTask({ agentId: 'worker', prompt: 'go', workingDirectory: '/tmp' })
		// The one emitted mid-spawn is not attributed — there was no id yet.
		expect(progressed).toEqual([])

		// Now the child speaks with the handle already in the caller's hands,
		// which is the case an idle bound is actually measuring.
		manager.speakNow()

		expect(progressed).toEqual(['task_spoke_early' as TaskId])
	})

	it('survives a concurrent fan-out, which is how this was found', async () => {
		const gateway = new LocalTaskScheduler(new TalksDuringSpawn(2), context())
		// Same reason as above: the live failure came through the idle bound's
		// subscriber, so a fan-out test without one would not reproduce the
		// thing it is named after.
		gateway.onTaskProgress?.(() => {})

		const launched = await Promise.all(
			[1, 2, 3, 4].map(() =>
				gateway.createTask({ agentId: 'worker', prompt: 'go', workingDirectory: '/tmp' }),
			),
		)

		expect(launched).toHaveLength(4)
		expect(launched.every((h) => h.taskId === 'task_spoke_early')).toBe(true)
	})
})
