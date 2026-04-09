import type { RunId, TaskId, TenantId } from '../ids/index.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export function isTerminalTaskStatus(status: TaskStatus): boolean {
	return status === 'completed'
}

export function assertTaskStatus(status: TaskStatus): void {
	switch (status) {
		case 'pending':
		case 'in_progress':
		case 'completed':
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
