import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { NAMZU } from '../../constants/telemetry/index.js'
import type { SessionLocator, SessionPaths } from '../../session/paths.js'
import type { SessionId, TaskId, TenantId } from '../../types/ids/index.js'
import type {
	CreateTaskParams,
	Task,
	TaskEvent,
	TaskEventListener,
	TaskStatus,
	TaskStore,
	UpdateTaskParams,
} from '../../types/task/index.js'
import { isTerminalTaskStatus } from '../../types/task/index.js'
import { asSessionId, asTenantId, asTurnId, generateTaskId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'
import { DiskRecordStore } from '../kv/record-store.js'
import { SchemaVersionError, defineSchema } from '../schema.js'

/**
 * This store's on-disk format, versioned as a unit.
 *
 * Version 2 keys a task by session (`<session-id>/tasks/<task-id>.json`) and
 * records the turn that created it. A version-1 task was keyed by run and
 * lived in a tree this build never reads (a clean start, not a migration), so
 * the step from 1 refuses rather than inventing a session for it.
 */
const SCHEMA = defineSchema({
	kind: 'task-store',
	current: 2,
	migrations: {
		1: () => {
			throw new SchemaVersionError({
				kind: 'task-store',
				found: 1,
				supported: 2,
				message:
					'A version-1 task was keyed by run; tasks are now kept per session under <session-id>/tasks/, and the old ones are not read.',
			})
		},
	},
})

/**
 * Read, write and list, through the one implementation.
 *
 * The try/catch at each call site stays. The primitive THROWS on a
 * corrupt record; this store logs and returns null, because a single
 * unreadable task must not make the whole list unavailable. That is a
 * policy of this store, not of the primitive, and it belongs here.
 */
const records = new DiskRecordStore<Task>(SCHEMA)

export interface DiskTaskStoreConfig {
	/** The project layout the session lives in. */
	paths: SessionPaths

	/**
	 * The session whose tasks this store keeps, at `<session-id>/tasks/`.
	 * A child session names its ancestors, root first, as everywhere else in
	 * the layout.
	 */
	session: SessionLocator

	/** Stamped on a task whose creator names no tenant. */
	tenantId?: TenantId

	logger?: Logger
}

/** A task was addressed to a session other than the one this store keeps. */
export class TaskSessionMismatchError extends Error {
	override readonly name = 'TaskSessionMismatchError'
	readonly expected: SessionId
	readonly actual: SessionId

	constructor(expected: SessionId, actual: SessionId) {
		super(
			`This task store keeps the tasks of session ${expected}; a task for session ${actual} belongs in that session's own store.`,
		)
		this.expected = expected
		this.actual = actual
	}
}

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

export class DiskTaskStore implements TaskStore {
	private readonly paths: SessionPaths
	private readonly session: SessionLocator
	private readonly tenantId?: TenantId
	private log: Logger
	private listeners: TaskEventListener[] = []

	private locks = new Map<TaskId, Promise<void>>()

	constructor(config: DiskTaskStoreConfig) {
		this.paths = config.paths
		this.session = {
			sessionId: asSessionId(config.session.sessionId),
			ancestors: (config.session.ancestors ?? []).map((id) => asSessionId(id)),
		}
		this.tenantId = config.tenantId === undefined ? undefined : asTenantId(config.tenantId)
		this.log = resolveLogger(config.logger).child({ [SCOPE_ATTRIBUTE]: 'store/task/disk' })
		// Resolved once, so a malformed locator is refused here rather than at
		// the first write.
		this.paths.tasks(this.session)
	}

	/** The session this store keeps the tasks of. */
	get sessionId(): SessionId {
		return this.session.sessionId
	}

	private taskDir(): string {
		return this.paths.tasks(this.session)
	}

	private taskPath(taskId: TaskId): string {
		return this.paths.taskFile(this.session, taskId)
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
		const unique = [...new Set(taskIds)].sort()
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
					'exception.message': err instanceof Error ? err.message : String(err),
					'namzu.event.type': event.type,
				})
			}
		}
	}

	async create(params: CreateTaskParams): Promise<Task> {
		const sessionId = asSessionId(params.sessionId)
		if (sessionId !== this.session.sessionId) {
			throw new TaskSessionMismatchError(this.session.sessionId, sessionId)
		}
		const turnId = asTurnId(params.turnId)
		const taskId = generateTaskId()

		const task: Task = {
			id: taskId,
			sessionId,
			turnId,
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

		await mkdir(this.taskDir(), { recursive: true, mode: 0o700 })

		const blockers = params.blockedBy ?? []
		if (blockers.length === 0) {
			await records.write(this.taskPath(taskId), task)
		} else {
			// Hold locks on all blockers while establishing the bidirectional edge:
			// update each blocker's `blocks` list AND write the new task together,
			// so concurrent delete(blockerId) sees a consistent pair.
			await this.withLocks(blockers, async () => {
				for (const blockerId of blockers) {
					const blocker = await this.readTask(blockerId)
					if (blocker && !blocker.blocks.includes(taskId)) {
						blocker.blocks.push(taskId)
						await records.write(this.taskPath(blockerId), blocker)
					}
					// If blocker is missing, we still write the new task with its
					// blockedBy reference; the dangling reference is visible to
					// subsequent readers rather than silently pruned.
				}
				await records.write(this.taskPath(taskId), task)
			})
		}

		this.log.info('Task created', {
			'namzu.task.id': taskId,
			'namzu.store.subject': params.subject,
			[NAMZU.TURN_ID]: turnId,
		})
		this.emit({ type: 'task.created', taskId, task, timestamp: Date.now() })
		return task
	}

	async get(id: TaskId): Promise<Task | undefined> {
		return (await this.readTask(id)) ?? undefined
	}

	async update(id: TaskId, updates: UpdateTaskParams): Promise<Task | undefined> {
		return this.withLock(id, async () => {
			const task = await this.readTask(id)
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
				// Stamped on either terminal status. The task context shows a
				// closed task only in the turn that closed it (spec §4.5), and a
				// failure with no time could never be placed in one.
				if (isTerminalTaskStatus(updates.status)) {
					task.completedAt = Date.now()
				}
			}

			await records.write(this.taskPath(id), task)
			this.emit({ type: 'task.updated', taskId: id, task, previousStatus, timestamp: Date.now() })
			return task
		})
	}

	async delete(id: TaskId): Promise<boolean> {
		// Read the task once (unlocked) to discover its related IDs, then acquire
		// locks on the entire set (self + blockers + blocked) in canonical order.
		// Locking the full set up-front in sorted order prevents deadlock when two
		// deletes race on tasks that mutually reference each other.
		//
		// Known trade-off: the lock set is computed from the unlocked preview. If
		// create()/block() adds a NEW relation between preview and lock acquisition,
		// we will mutate that neighbor without holding its lock. The alternative
		// (retry loop with expanding lock set) adds substantial complexity for a
		// rare interleaving in a single-writer store; the session lease is what
		// keeps a second process out.
		const preview = await this.readTask(id)
		if (!preview) return false

		const relatedIds: TaskId[] = [id, ...preview.blockedBy, ...preview.blocks]

		return this.withLocks(relatedIds, async () => {
			// Re-read under lock: the task's block graph may have changed between
			// the unlocked preview and lock acquisition.
			const task = await this.readTask(id)
			if (!task) return false

			for (const blockerId of task.blockedBy) {
				const blocker = await this.readTask(blockerId)
				if (blocker) {
					blocker.blocks = blocker.blocks.filter((bid) => bid !== id)
					await records.write(this.taskPath(blockerId), blocker)
				}
			}
			for (const blockedId of task.blocks) {
				const blocked = await this.readTask(blockedId)
				if (blocked) {
					blocked.blockedBy = blocked.blockedBy.filter((bid) => bid !== id)
					await records.write(this.taskPath(blockedId), blocked)
				}
			}

			try {
				await unlink(this.taskPath(id))
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code
				if (code !== 'ENOENT') {
					this.log.error(
						'Failed to delete task file; relations may be in a partially-updated state',
						{
							'namzu.task.id': id,
							'exception.message': err instanceof Error ? err.message : String(err),
						},
					)
					throw err
				}
				// ENOENT: already gone, treat as success.
			}
			this.log.info('Task deleted', { 'namzu.task.id': id })
			this.emit({ type: 'task.deleted', taskId: id, task, timestamp: Date.now() })
			return true
		})
	}

	/**
	 * Every task of this store's session, oldest first. A `sessionId` filter
	 * naming a different session lists nothing: that session's tasks are in
	 * its own directory, not here.
	 */
	async list(filter?: { status?: TaskStatus; owner?: string; sessionId?: SessionId }): Promise<
		Task[]
	> {
		if (filter?.sessionId !== undefined && filter.sessionId !== this.session.sessionId) return []
		const dir = this.taskDir()

		let files: string[]
		try {
			files = await records.scanNames(dir, '')
		} catch (err) {
			this.log.warn('Failed to list task directory', {
				'namzu.store.dir': dir,
				'exception.message': err instanceof Error ? err.message : String(err),
			})
			return []
		}

		const tasks: Task[] = []
		for (const file of files) {
			if (!file.endsWith('.json')) continue
			try {
				const task = await records.read(join(dir, file))
				if (task !== null) tasks.push(task)
			} catch (err) {
				this.log.warn('Failed to read task file', {
					'namzu.store.file': file,
					'exception.message': err instanceof Error ? err.message : String(err),
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

		return results.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
	}

	async claim(id: TaskId, owner: string): Promise<Task | undefined> {
		return this.withLock(id, async () => {
			const task = await this.readTask(id)
			if (!task) return undefined
			if (task.status !== 'pending') return undefined
			if (task.owner !== undefined) return undefined

			task.owner = owner
			task.status = 'in_progress'
			task.startedAt = Date.now()

			await records.write(this.taskPath(id), task)
			this.emit({ type: 'task.claimed', taskId: id, task, timestamp: Date.now() })
			return task
		})
	}

	async block(blockerId: TaskId, blockedId: TaskId): Promise<void> {
		// Acquire BOTH locks before mutating either side of the edge. Sequential
		// single-locks allow a concurrent operation to interleave and observe
		// a half-established relationship.
		await this.withLocks([blockerId, blockedId], async () => {
			const blocker = await this.readTask(blockerId)
			const blocked = await this.readTask(blockedId)

			// Either side may be missing. Establishing only one side of the edge
			// would leave a dangling reference; skip the whole operation instead.
			if (!blocker || !blocked) {
				this.log.warn('block(): a task of the edge does not exist; skipping', {
					'namzu.store.blocker_id': blockerId,
					'namzu.store.blocked_id': blockedId,
					'namzu.store.blocker_exists': !!blocker,
					'namzu.store.blocked_exists': !!blocked,
				})
				return
			}

			let mutated = false
			if (!blocker.blocks.includes(blockedId)) {
				blocker.blocks.push(blockedId)
				await records.write(this.taskPath(blockerId), blocker)
				mutated = true
			}
			if (!blocked.blockedBy.includes(blockerId)) {
				blocked.blockedBy.push(blockerId)
				await records.write(this.taskPath(blockedId), blocked)
				mutated = true
			}
			if (!mutated) {
				this.log.debug('block(): edge already exists', {
					'namzu.store.blocker_id': blockerId,
					'namzu.store.blocked_id': blockedId,
				})
				return
			}

			// Announce BOTH ends, and only when something actually changed. The
			// edge was written and nothing said so, so the graph was observable
			// only by polling — a listener saw a unit created and never learned
			// that something now waits on it.
			const now = Date.now()
			this.emit({ type: 'task.updated', taskId: blockerId, task: blocker, timestamp: now })
			this.emit({ type: 'task.updated', taskId: blockedId, task: blocked, timestamp: now })
		})
	}

	async reset(): Promise<void> {
		const dir = this.taskDir()
		const files = await records.scanNames(dir, '')
		for (const file of files) {
			if (file.endsWith('.json')) {
				await unlink(join(dir, file)).catch(() => undefined)
			}
		}
	}

	private async readTask(taskId: TaskId): Promise<Task | null> {
		const path = this.taskPath(taskId)
		try {
			return await records.read(path)
		} catch (err) {
			this.log.error('Corrupt task JSON on disk', {
				'namzu.task.id': taskId,
				'namzu.store.path': path,
				'exception.message': err instanceof Error ? err.message : String(err),
			})
			return null
		}
	}
}
