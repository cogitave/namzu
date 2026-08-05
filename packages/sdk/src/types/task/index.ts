import type { RunId, TaskId, TenantId } from '../ids/index.js'

/**
 * `failed` exists because a unit that did not succeed had nowhere to say so.
 *
 * Delegation wrote a failed worker's task as `completed` with the failure
 * encoded as prose in `description` — so a reader scanning statuses saw work
 * that had been done, and only a reader of every description saw otherwise. A
 * status nobody can set is a status nobody can act on: a dependent unit cannot
 * decide whether to wait or give up, and a plan cannot report that it did not
 * finish.
 */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

/**
 * Terminal means "will not change on its own", not "succeeded".
 *
 * `failed` is terminal for the same reason `completed` is: nothing downstream
 * should wait on it. That matters most to the blocker check in the task
 * listing — a dependent unit blocked on something that failed would otherwise
 * wait forever for a status that will never arrive.
 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === 'completed' || status === 'failed'
}

export function assertTaskStatus(status: TaskStatus): void {
	switch (status) {
		case 'pending':
		case 'in_progress':
		case 'completed':
		case 'failed':
			return
		default: {
			const _exhaustive: never = status
			throw new Error(`Unknown TaskStatus: ${_exhaustive}`)
		}
	}
}

export interface Task {
	readonly id: TaskId
	readonly runId: RunId
	readonly tenantId?: TenantId

	subject: string

	description?: string

	activeForm?: string

	status: TaskStatus

	owner?: string

	blocks: TaskId[]

	blockedBy: TaskId[]

	metadata?: Record<string, unknown>

	createdAt: number
	startedAt?: number
	completedAt?: number
}

export type TaskEventType = 'task.created' | 'task.updated' | 'task.deleted' | 'task.claimed'

export interface TaskEvent {
	type: TaskEventType
	taskId: TaskId
	task: Task
	previousStatus?: TaskStatus
	timestamp: number
}

export type TaskEventListener = (event: TaskEvent) => void

export interface CreateTaskParams {
	runId: RunId
	tenantId?: TenantId
	subject: string
	description?: string
	activeForm?: string
	owner?: string
	blockedBy?: TaskId[]
	metadata?: Record<string, unknown>
}

export interface UpdateTaskParams {
	subject?: string
	description?: string
	activeForm?: string
	status?: TaskStatus
	owner?: string
	metadata?: Record<string, unknown>
}

export interface TaskStore {
	create(params: CreateTaskParams): Promise<Task>
	get(id: TaskId): Promise<Task | undefined>
	update(id: TaskId, updates: UpdateTaskParams): Promise<Task | undefined>
	delete(id: TaskId): Promise<boolean>
	list(filter?: { status?: TaskStatus; owner?: string; runId?: RunId }): Promise<Task[]>

	claim(id: TaskId, owner: string): Promise<Task | undefined>

	block(blockerId: TaskId, blockedId: TaskId): Promise<void>

	on(listener: TaskEventListener): () => void
	reset(): Promise<void>
}
