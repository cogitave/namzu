import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunId, TaskId, TenantId } from '../../types/ids/index.js'
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
import { type Logger, getRootLogger } from '../../utils/logger.js'

export interface DiskTaskStoreConfig {
	baseDir: string

	defaultRunId: RunId

	tenantId?: TenantId

	logger?: Logger
}

const STATUS_ORDER: Record<TaskStatus, number> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
}

function isForwardTransition(from: TaskStatus, to: TaskStatus): boolean {
	return STATUS_ORDER[to] > STATUS_ORDER[from]
}

export class DiskTaskStore implements TaskStore {
	private baseDir: string
	private defaultRunId: RunId
	private tenantId?: TenantId
	private log: Logger
	private listeners: TaskEventListener[] = []

	private locks = new Map<TaskId, Promise<void>>()

	constructor(config: DiskTaskStoreConfig) {
		this.baseDir = config.baseDir
		this.defaultRunId = config.defaultRunId
		this.tenantId = config.tenantId
		this.log = (config.logger ?? getRootLogger()).child({ component: 'DiskTaskStore' })
	}

	private taskDir(runId: RunId): string {
		if (this.tenantId) {
			return join(this.baseDir, 'tenants', this.tenantId, 'tasks', runId)
		}
		return join(this.baseDir, 'tasks', runId)
	}

	private taskPath(runId: RunId, taskId: TaskId): string {
		return join(this.taskDir(runId), `${taskId}.json`)
	}

	private async withLock<T>(taskId: TaskId, fn: () => Promise<T>): Promise<T> {
		// Loop instead of single await: after awaiting a lock, the map may
		// already hold a NEW lock acquired by another coroutine that woke
		// up before us. Re-check on each iteration until we observe an empty
		// slot, at which point the synchronous set() below claims it.
		while (true) {
			const existing = this.locks.get(taskId)
			if (!existing) break
			await existing.catch(() => undefined)
		}

		let resolve!: () => void
		const lock = new Promise<void>((r) => {
			resolve = r
		})
		this.locks.set(taskId, lock)

		try {
			return await fn()
		} finally {
			resolve?.()
			if (this.locks.get(taskId) === lock) {
				this.locks.delete(taskId)
			}
		}
	}

	/**
	 * Acquires locks on multiple task IDs in a canonical (lexicographic) order
	 * to prevent deadlocks when operations touch several related tasks.
	 * Duplicates are removed; each ID is locked exactly once.
	 */
	private async withLocks<T>(taskIds: readonly TaskId[], fn: () => Promise<T>): Promise<T> {
		const unique = [...new Set(taskIds)].sort() as TaskId[]
		const acquire = async (i: number): Promise<T> => {
			if (i >= unique.length) return fn()
			const nextId = unique[i]
			if (nextId === undefined) return fn()
			return this.withLock(nextId, () => acquire(i + 1))
		}
		return acquire(0)
	}

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
			} catch (err) {
				this.log.warn('Task event listener threw', {
					error: err instanceof Error ? err.message : String(err),
					eventType: event.type,
				})
			}
		}
	}

	async create(params: CreateTaskParams): Promise<Task> {
		const taskId = generateTaskId()
		const runId = params.runId ?? this.defaultRunId

		const task: Task = {
			id: taskId,
			runId,
			tenantId: params.tenantId ?? this.tenantId,
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

		const dir = this.taskDir(runId)
		await mkdir(dir, { recursive: true })

		const blockers = params.blockedBy ?? []
		if (blockers.length === 0) {
			await atomicWriteJson(this.taskPath(runId, taskId), task)
		} else {
			// Hold locks on all blockers while establishing the bidirectional edge:
			// update each blocker's `blocks` list AND write the new task together,
			// so concurrent delete(blockerId) sees a consistent pair.
			await this.withLocks(blockers, async () => {
				for (const blockerId of blockers) {
					const blocker = await this.readTask(runId, blockerId)
					if (blocker && !blocker.blocks.includes(taskId)) {
						blocker.blocks.push(taskId)
						await atomicWriteJson(this.taskPath(runId, blockerId), blocker)
					}
					// If blocker is missing, we still write the new task with its
					// blockedBy reference; the dangling reference is visible to
					// subsequent readers rather than silently pruned.
				}
				await atomicWriteJson(this.taskPath(runId, taskId), task)
			})
		}

		this.log.info('Task created', { taskId, subject: params.subject, runId })
		this.emit({ type: 'task.created', taskId, task, timestamp: Date.now() })
		return task
	}

	async get(id: TaskId): Promise<Task | undefined> {
		return this.findTask(id)
	}

	async update(id: TaskId, updates: UpdateTaskParams): Promise<Task | undefined> {
		const found = await this.findTask(id)
		if (!found) return undefined

		return this.withLock(id, async () => {
			const task = await this.readTask(found.runId, id)
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

			await atomicWriteJson(this.taskPath(task.runId, id), task)
			this.emit({ type: 'task.updated', taskId: id, task, previousStatus, timestamp: Date.now() })
			return task
		})
	}

	async delete(id: TaskId): Promise<boolean> {
		const found = await this.findTask(id)
		if (!found) return false

		// Read the task once (unlocked) to discover its related IDs, then acquire
		// locks on the entire set (self + blockers + blocked) in canonical order.
		// Locking the full set up-front in sorted order prevents deadlock when two
		// deletes race on tasks that mutually reference each other.
		//
		// Known trade-off: the lock set is computed from the unlocked preview. If
		// create()/block() adds a NEW relation between preview and lock acquisition,
		// we will mutate that neighbor without holding its lock. The alternative
		// (retry loop with expanding lock set) adds substantial complexity for a
		// rare interleaving in a single-tenant single-writer store; revisit if the
		// store grows concurrent writers.
		const preview = await this.readTask(found.runId, id)
		if (!preview) return false

		const relatedIds: TaskId[] = [id, ...preview.blockedBy, ...preview.blocks]

		return this.withLocks(relatedIds, async () => {
			// Re-read under lock: the task's block graph may have changed between
			// the unlocked preview and lock acquisition.
			const task = await this.readTask(found.runId, id)
			if (!task) return false

			for (const blockerId of task.blockedBy) {
				const blocker = await this.readTask(task.runId, blockerId)
				if (blocker) {
					blocker.blocks = blocker.blocks.filter((bid) => bid !== id)
					await atomicWriteJson(this.taskPath(task.runId, blockerId), blocker)
				}
			}
			for (const blockedId of task.blocks) {
				const blocked = await this.readTask(task.runId, blockedId)
				if (blocked) {
					blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== id)
					await atomicWriteJson(this.taskPath(task.runId, blockedId), blocked)
				}
			}

			try {
				await unlink(this.taskPath(task.runId, id))
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code
				if (code !== 'ENOENT') {
					this.log.error(
						'Failed to delete task file; relations may be in a partially-updated state',
						{
							taskId: id,
							error: err instanceof Error ? err.message : String(err),
						},
					)
					throw err
				}
				// ENOENT: already gone, treat as success.
			}
			this.log.info('Task deleted', { taskId: id })
			this.emit({ type: 'task.deleted', taskId: id, task, timestamp: Date.now() })
			return true
		})
	}

	async list(filter?: { status?: TaskStatus; owner?: string; runId?: RunId }): Promise<Task[]> {
		const runId = filter?.runId ?? this.defaultRunId
		const dir = this.taskDir(runId)

		let files: string[]
		try {
			files = await readdir(dir)
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return []
			this.log.warn('Failed to list task directory', {
				dir,
				error: err instanceof Error ? err.message : String(err),
			})
			return []
		}

		const tasks: Task[] = []
		for (const file of files) {
			if (!file.endsWith('.json')) continue
			try {
				const raw = await readFile(join(dir, file), 'utf-8')
				const task = JSON.parse(raw) as Task
				tasks.push(task)
			} catch (err) {
				this.log.warn('Failed to read task file', {
					file,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}

		let results = tasks
		if (filter?.status) {
			results = results.filter((t) => t.status === filter.status)
		}
		if (filter?.owner) {
			results = results.filter((t) => t.owner === filter.owner)
		}

		return results.sort((a, b) => a.createdAt - b.createdAt)
	}

	async claim(id: TaskId, owner: string): Promise<Task | undefined> {
		const found = await this.findTask(id)
		if (!found) return undefined

		return this.withLock(id, async () => {
			const task = await this.readTask(found.runId, id)
			if (!task) return undefined
			if (task.status !== 'pending') return undefined
			if (task.owner !== undefined) return undefined

			task.owner = owner
			task.status = 'in_progress'
			task.startedAt = Date.now()

			await atomicWriteJson(this.taskPath(task.runId, id), task)
			this.emit({ type: 'task.claimed', taskId: id, task, timestamp: Date.now() })
			return task
		})
	}

	async block(blockerId: TaskId, blockedId: TaskId): Promise<void> {
		const blockerFound = await this.findTask(blockerId)
		const blockedFound = await this.findTask(blockedId)
		if (!blockerFound || !blockedFound) return

		// Acquire BOTH locks before mutating either side of the edge. Sequential
		// single-locks allow a concurrent operation to interleave and observe
		// a half-established relationship.
		await this.withLocks([blockerId, blockedId], async () => {
			const blocker = await this.readTask(blockerFound.runId, blockerId)
			const blocked = await this.readTask(blockedFound.runId, blockedId)

			// Re-validate under lock: either side may have been deleted between
			// the pre-check (findTask) and lock acquisition. Establishing only
			// one side of the edge would leave a dangling reference; skip the
			// whole operation instead.
			if (!blocker || !blocked) {
				this.log.warn('block(): task disappeared before lock acquired; skipping', {
					blockerId,
					blockedId,
					blockerExists: !!blocker,
					blockedExists: !!blocked,
				})
				return
			}

			let mutated = false
			if (!blocker.blocks.includes(blockedId)) {
				blocker.blocks.push(blockedId)
				await atomicWriteJson(this.taskPath(blocker.runId, blockerId), blocker)
				mutated = true
			}
			if (!blocked.blockedBy.includes(blockerId)) {
				blocked.blockedBy.push(blockerId)
				await atomicWriteJson(this.taskPath(blocked.runId, blockedId), blocked)
				mutated = true
			}
			if (!mutated) {
				this.log.debug('block(): edge already exists', { blockerId, blockedId })
			}
		})
	}

	async reset(): Promise<void> {
		const dir = this.taskDir(this.defaultRunId)
		let files: string[]
		try {
			files = await readdir(dir)
		} catch {
			return
		}
		for (const file of files) {
			if (file.endsWith('.json')) {
				await unlink(join(dir, file)).catch(() => undefined)
			}
		}
	}

	private async readTask(runId: RunId, taskId: TaskId): Promise<Task | null> {
		const path = this.taskPath(runId, taskId)
		let raw: string
		try {
			raw = await readFile(path, 'utf-8')
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code
			if (code === 'ENOENT') return null
			this.log.warn('Failed to read task', {
				taskId,
				path,
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		}

		try {
			return JSON.parse(raw) as Task
		} catch (err) {
			this.log.error('Corrupt task JSON on disk', {
				taskId,
				path,
				error: err instanceof Error ? err.message : String(err),
			})
			return null
		}
	}

	private async findTask(id: TaskId): Promise<Task | undefined> {
		const task = await this.readTask(this.defaultRunId, id)
		return task ?? undefined
	}
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.tmp`
	try {
		await writeFile(tempPath, content, 'utf-8')
		await rename(tempPath, filePath)
	} catch (err) {
		await unlink(tempPath).catch(() => undefined)
		throw err
	}
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
	await atomicWriteFile(filePath, JSON.stringify(value, null, 2))
}
