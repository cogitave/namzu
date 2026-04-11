import type { PlanEvent, PlanManager } from '../../manager/plan/lifecycle.js'
import type { RunPersistence } from '../../manager/run/persistence.js'
import type { ActivityEvent, ActivityStore } from '../../store/activity/memory.js'
import type { RunId } from '../../types/ids/index.js'
import type { RunEvent } from '../../types/run/index.js'
import type { TaskEvent, TaskStore } from '../../types/task/index.js'

export type EmitEvent = (event: RunEvent) => Promise<void>

export class EventTranslator {
	private pendingEvents: RunEvent[] = []
	private runMgr: RunPersistence

	constructor(runMgr: RunPersistence) {
		this.runMgr = runMgr
	}

	readonly emitEvent: EmitEvent = async (event: RunEvent): Promise<void> => {
		this.pendingEvents.push(event)
		await this.runMgr.getRunStore().appendEvent(event)
	};

	*drainPending(): Generator<RunEvent> {
		let event = this.pendingEvents.shift()
		while (event !== undefined) {
			yield event
			event = this.pendingEvents.shift()
		}
	}

	wireActivityStore(activityStore: ActivityStore, runId: RunId): void {
		activityStore.on((event: ActivityEvent) => {
			const activity = event.activity
			if (event.type === 'activity.created') {
				this.emitEvent({
					type: 'activity_created',
					runId,
					activityId: activity.id,
					activityType: activity.type,
					description: activity.description,
				})
			} else {
				this.emitEvent({
					type: 'activity_updated',
					runId,
					activityId: activity.id,
					status: activity.status,
					output: activity.output,
					error: activity.error,
				})
			}
		})
	}

	wireTaskStore(taskStore: TaskStore, runId: RunId): () => void {
		const unsubscribe = taskStore.on((event: TaskEvent) => {
			const task = event.task

			if (task.runId !== runId) return
			switch (event.type) {
				case 'task.created':
					this.emitEvent({
						type: 'task_created',
						runId,
						taskId: task.id,
						subject: task.subject,
						status: task.status,
					})
					break
				case 'task.updated':
				case 'task.claimed':
				case 'task.deleted':
					this.emitEvent({
						type: 'task_updated',
						runId,
						taskId: task.id,
						subject: task.subject,
						status: task.status,
						owner: task.owner,
					})
					break
				default: {
					const _exhaustive: never = event.type
					throw new Error(`Unhandled task event type: ${_exhaustive}`)
				}
			}
		})
		return unsubscribe
	}

	wirePlanManager(planManager: PlanManager, runId: RunId): void {
		planManager.on((event: PlanEvent) => {
			const plan = event.plan
			switch (event.type) {
				case 'plan.ready':
					this.emitEvent({
						type: 'plan_ready',
						runId,
						planId: plan.id,
						title: plan.title,
						steps: plan.steps,
						summary: plan.summary,
					})
					break
				case 'plan.approved':
					this.emitEvent({
						type: 'plan_approved',
						runId,
						planId: plan.id,
					})
					break
				case 'plan.rejected':
					this.emitEvent({
						type: 'plan_rejected',
						runId,
						planId: plan.id,
						reason: plan.rejectionReason,
					})
					break
				case 'plan.step_updated':
					if (event.step) {
						this.emitEvent({
							type: 'plan_step_updated',
							runId,
							planId: plan.id,
							stepId: event.step.id,
							status: event.step.status,
						})
					}
					break
				case 'plan.generating':
				case 'plan.executing':
				case 'plan.completed':
				case 'plan.failed':
					break
				default: {
					const _exhaustive: never = event.type
					throw new Error(`Unhandled plan event type: ${_exhaustive}`)
				}
			}
		})
	}
}
