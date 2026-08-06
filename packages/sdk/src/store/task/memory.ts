import type { RunId, TaskId } from '../../types/ids/index.js'
import type {
	CreateTaskParams,
	Task,
	TaskEvent,
	TaskEventListener,
	TaskStatus,
	TaskStore,
	UpdateTaskParams,
} from '../../types/task/index.js'
import { generateTaskId } from '../../utils/id.js'

// `failed` ranks alongside `completed` rather than after it: both are
// terminal, and neither may transition to the other. Ranking it higher would
// admit completed -> failed, which would let a settled unit be reopened as a
// failure; ranking it lower would forbid in_progress -> failed, which is the
// transition this status exists for.
const STATUS_ORDER: Record<TaskStatus, number> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
	failed: 2,
}

function isForwardTransition(from: TaskStatus, to: TaskStatus): boolean {
	return STATUS_ORDER[to] > STATUS_ORDER[from]
}

export class InMemoryTaskStore implements TaskStore {
	private tasks = new Map<TaskId, Task>()
	private listeners: TaskEventListener[] = []

	on(listener: TaskEventListener): () => void {
		this.listeners.push(listener)
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener)
		}
	}

	private emit(event: TaskEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event)
			} catch {}
		}
	}

	async create(params: CreateTaskParams): Promise<Task> {
		const task: Task = {
			id: generateTaskId(),
			runId: params.runId,
			tenantId: params.tenantId,
			subject: params.subject,
			description: params.description,
			activeForm: params.activeForm,
			status: 'pending',
			owner: params.owner,
			blocks: [],
			blockedBy: params.blockedBy ? [...params.blockedBy] : [],
			metadata: params.metadata ? { ...params.metadata } : undefined,
			createdAt: Date.now(),
		}

		this.tasks.set(task.id, task)

		if (params.blockedBy) {
			for (const blockerId of params.blockedBy) {
				const blocker = this.tasks.get(blockerId)
				if (blocker) {
					blocker.blocks.push(task.id)
				}
			}
		}

		this.emit({ type: 'task.created', taskId: task.id, task, timestamp: Date.now() })
		return task
	}

	async get(id: TaskId): Promise<Task | undefined> {
		return this.tasks.get(id)
	}

	async update(id: TaskId, updates: UpdateTaskParams): Promise<Task | undefined> {
		const task = this.tasks.get(id)
		if (!task) return undefined

		const previousStatus = task.status

		if (updates.subject !== undefined) task.subject = updates.subject
		if (updates.description !== undefined) task.description = updates.description
		if (updates.activeForm !== undefined) task.activeForm = updates.activeForm
		if (updates.owner !== undefined) task.owner = updates.owner
		if (updates.metadata !== undefined) {
			task.metadata = task.metadata
				? { ...task.metadata, ...updates.metadata }
				: { ...updates.metadata }
		}

		if (
			updates.status !== undefined &&
			updates.status !== previousStatus &&
			isForwardTransition(previousStatus, updates.status)
		) {
			task.status = updates.status
			if (updates.status === 'in_progress' && !task.startedAt) {
				task.startedAt = Date.now()
			}
			if (updates.status === 'completed') {
				task.completedAt = Date.now()
			}
		}

		this.emit({
			type: 'task.updated',
			taskId: task.id,
			task,
			previousStatus,
			timestamp: Date.now(),
		})
		return task
	}

	async delete(id: TaskId): Promise<boolean> {
		const task = this.tasks.get(id)
		if (!task) return false

		for (const blockerId of task.blockedBy) {
			const blocker = this.tasks.get(blockerId)
			if (blocker) {
				blocker.blocks = blocker.blocks.filter((bid) => bid !== id)
			}
		}
		for (const blockedId of task.blocks) {
			const blocked = this.tasks.get(blockedId)
			if (blocked) {
				blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== id)
			}
		}

		this.tasks.delete(id)
		this.emit({ type: 'task.deleted', taskId: id, task, timestamp: Date.now() })
		return true
	}

	async list(filter?: { status?: TaskStatus; owner?: string; runId?: RunId }): Promise<Task[]> {
		let results = Array.from(this.tasks.values())

		if (filter?.status) {
			results = results.filter((t) => t.status === filter.status)
		}
		if (filter?.owner) {
			results = results.filter((t) => t.owner === filter.owner)
		}
		if (filter?.runId) {
			results = results.filter((t) => t.runId === filter.runId)
		}

		return results.sort((a, b) => a.createdAt - b.createdAt)
	}

	async claim(id: TaskId, owner: string): Promise<Task | undefined> {
		const task = this.tasks.get(id)
		if (!task) return undefined
		if (task.status !== 'pending') return undefined
		if (task.owner !== undefined) return undefined

		task.owner = owner
		task.status = 'in_progress'
		task.startedAt = Date.now()

		this.emit({ type: 'task.claimed', taskId: task.id, task, timestamp: Date.now() })
		return task
	}

	async block(blockerId: TaskId, blockedId: TaskId): Promise<void> {
		const blocker = this.tasks.get(blockerId)
		const blocked = this.tasks.get(blockedId)
		if (!blocker || !blocked) return

		let mutated = false
		if (!blocker.blocks.includes(blockedId)) {
			blocker.blocks.push(blockedId)
			mutated = true
		}
		if (!blocked.blockedBy.includes(blockerId)) {
			blocked.blockedBy.push(blockerId)
			mutated = true
		}
		// An edge that already existed is not news. This used to announce
		// unconditionally while the disk store — the one a host runs in
		// production — returned early, so the same call sequence produced two
		// events from one implementation and none from the other. A host
		// rebuilding a graph from the stream did redundant work against one
		// store and not the other, and a host counting events to detect change
		// saw change where there was none.
		if (!mutated) return

		// Announce BOTH ends. The edge was written and nothing said so, which
		// left the graph observable only by polling: a listener saw a unit
		// created and never learned that something now waits on it. Both sides
		// are one fact, so both are announced even when only one array grew —
		// a host tracking a single side would draw half the edge.
		const now = Date.now()
		this.emit({ type: 'task.updated', taskId: blockerId, task: blocker, timestamp: now })
		this.emit({ type: 'task.updated', taskId: blockedId, task: blocked, timestamp: now })
	}

	async reset(): Promise<void> {
		this.tasks.clear()
	}
}
