import type {
	Activity,
	ActivityProgress,
	ActivityStatus,
	ActivityTrackingConfig,
	ActivityType,
} from '../../types/activity/index.js'
import { isTerminalActivityStatus } from '../../types/activity/index.js'
import type { ActivityId, RunId } from '../../types/ids/index.js'
import { generateActivityId } from '../../utils/id.js'

export interface ActivityEvent {
	type:
		| 'activity.created'
		| 'activity.started'
		| 'activity.progress'
		| 'activity.completed'
		| 'activity.failed'
		| 'activity.cancelled'
	activity: Activity
}

export type ActivityEventListener = (event: ActivityEvent) => void

export class ActivityStore {
	private activities = new Map<ActivityId, Activity>()
	private runId: RunId
	private config: ActivityTrackingConfig
	private listeners: ActivityEventListener[] = []

	constructor(runId: RunId, config: ActivityTrackingConfig) {
		this.runId = runId
		this.config = config
	}

	get enabled(): boolean {
		return this.config.enabled
	}

	on(listener: ActivityEventListener): () => void {
		this.listeners.push(listener)
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener)
		}
	}

	private emit(event: ActivityEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {}
		}
	}

	create(params: {
		type: ActivityType
		description: string
		input?: unknown
		parentActivityId?: ActivityId
		toolName?: string
		toolCallId?: string
		blockedBy?: ActivityId[]
	}): Activity | null {
		if (!this.config.enabled) return null
		if (params.type === 'tool_call' && !this.config.trackToolCalls) return null
		if (params.type === 'llm_turn' && !this.config.trackLlmTurns) return null

		const activity: Activity = {
			id: generateActivityId(),
			runId: this.runId,
			type: params.type,
			status: 'pending',
			description: params.description,
			input: params.input,
			parentActivityId: params.parentActivityId,
			toolName: params.toolName,
			toolCallId: params.toolCallId,
			blockedBy: params.blockedBy ?? [],
			blocks: [],
			createdAt: Date.now(),
		}

		this.activities.set(activity.id, activity)

		if (params.blockedBy) {
			for (const blockerId of params.blockedBy) {
				const blocker = this.activities.get(blockerId)
				if (blocker) {
					blocker.blocks.push(activity.id)
				}
			}
		}

		this.emit({ type: 'activity.created', activity })
		return activity
	}

	start(activityId: ActivityId): Activity | null {
		const activity = this.activities.get(activityId)
		if (!activity || activity.status !== 'pending') return null

		const unblockedDeps = activity.blockedBy.filter((depId) => {
			const dep = this.activities.get(depId)
			return dep && !isTerminalActivityStatus(dep.status)
		})

		if (unblockedDeps.length > 0) return null

		activity.status = 'running'
		activity.startedAt = Date.now()
		this.emit({ type: 'activity.started', activity })
		return activity
	}

	updateProgress(
		activityId: ActivityId,
		progress: Omit<ActivityProgress, 'updatedAt'>,
	): Activity | null {
		const activity = this.activities.get(activityId)
		if (!activity || activity.status !== 'running') return null

		activity.progress = { ...progress, updatedAt: Date.now() }
		this.emit({ type: 'activity.progress', activity })
		return activity
	}

	complete(activityId: ActivityId, output?: unknown): Activity | null {
		const activity = this.activities.get(activityId)
		if (!activity || isTerminalActivityStatus(activity.status)) return null

		activity.status = 'completed'
		activity.output = output
		activity.completedAt = Date.now()
		activity.durationMs = activity.startedAt ? activity.completedAt - activity.startedAt : 0
		this.emit({ type: 'activity.completed', activity })
		return activity
	}

	fail(activityId: ActivityId, error: string): Activity | null {
		const activity = this.activities.get(activityId)
		if (!activity || isTerminalActivityStatus(activity.status)) return null

		activity.status = 'failed'
		activity.error = error
		activity.completedAt = Date.now()
		activity.durationMs = activity.startedAt ? activity.completedAt - activity.startedAt : 0
		this.emit({ type: 'activity.failed', activity })
		return activity
	}

	cancel(activityId: ActivityId): Activity | null {
		const activity = this.activities.get(activityId)
		if (!activity || isTerminalActivityStatus(activity.status)) return null

		activity.status = 'cancelled'
		activity.completedAt = Date.now()
		activity.durationMs = activity.startedAt ? activity.completedAt - activity.startedAt : 0
		this.emit({ type: 'activity.cancelled', activity })
		return activity
	}

	get(activityId: ActivityId): Activity | undefined {
		return this.activities.get(activityId)
	}

	getByToolCallId(toolCallId: string): Activity | undefined {
		for (const activity of this.activities.values()) {
			if (activity.toolCallId === toolCallId) return activity
		}
		return undefined
	}

	list(filter?: { status?: ActivityStatus; type?: ActivityType }): Activity[] {
		let results = Array.from(this.activities.values())

		if (filter?.status) {
			results = results.filter((a) => a.status === filter.status)
		}

		if (filter?.type) {
			results = results.filter((a) => a.type === filter.type)
		}

		return results.sort((a, b) => a.createdAt - b.createdAt)
	}

	getBlockedActivities(): Activity[] {
		return this.list().filter((activity) => {
			if (activity.status !== 'pending') return false
			return activity.blockedBy.some((depId) => {
				const dep = this.activities.get(depId)
				return dep && !isTerminalActivityStatus(dep.status)
			})
		})
	}

	getReadyActivities(): Activity[] {
		return this.list().filter((activity) => {
			if (activity.status !== 'pending') return false
			return activity.blockedBy.every((depId) => {
				const dep = this.activities.get(depId)
				return !dep || isTerminalActivityStatus(dep.status)
			})
		})
	}

	stats(): {
		total: number
		pending: number
		running: number
		completed: number
		failed: number
		cancelled: number
	} {
		const all = this.list()
		return {
			total: all.length,
			pending: all.filter((a) => a.status === 'pending').length,
			running: all.filter((a) => a.status === 'running').length,
			completed: all.filter((a) => a.status === 'completed').length,
			failed: all.filter((a) => a.status === 'failed').length,
			cancelled: all.filter((a) => a.status === 'cancelled').length,
		}
	}

	clear(): void {
		this.activities.clear()
	}
}
