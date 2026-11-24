import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NAMZU } from '../../constants/telemetry/index.js'
import { resolveNamzuHome } from '../../session/home.js'
import { lockedSync, removeSync, sleepSync, writeAtomicSync } from '../../teams/fs-sync.js'
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
import { asSessionId, asTaskId, asTurnId, generateTaskId } from '../../utils/id.js'
import { SCOPE_ATTRIBUTE } from '../../utils/log/types.js'
import { type Logger, resolveLogger } from '../../utils/logger.js'

/**
 * A task list that several processes share, kept at `<NAMZU_HOME>/tasks/<list id>/`: one JSON file
 * per task, a `.highwatermark` file that issues each task its place in the list (a place is never
 * handed out twice, not even after the task is deleted), and lock files beside what they guard.
 *
 * Unlike {@link DiskTaskStore}, whose locks live in one process, every change here runs under a lock
 * file (the shared `utils/file-lock` protocol: create-exclusive, owner pid recorded, a lock whose owner
 * has exited is taken over). Two terminals, Desktop and a later process backend can therefore claim from
 * one list and each task is claimed exactly once. Lock order is fixed: the list lock first, then task
 * locks in sorted id order, so two changes cannot wait on each other.
 *
 * The list id is the team name when the list belongs to a team, else the session id. Task ids stay the
 * usual entity ids; the order of a list is the `seq` the high-water mark issued, which is what "the
 * lowest task" means.
 *
 * Events reach listeners in the process that made the change, not in other processes.
 *
 * @experimental
 */

export type TaskClaimFailure = 'not_found' | 'already_claimed' | 'already_resolved' | 'blocked'

export type TaskClaimResult =
	| { readonly ok: true; readonly task: Task }
	| {
			readonly ok: false
			readonly code: TaskClaimFailure
			readonly task?: Task
			/** For `blocked`: the blockers that are not completed. */
			readonly blockedBy?: readonly TaskId[]
	  }

export type TaskListErrorCode =
	| 'cycle'
	| 'not_found'
	| 'not_all_completed'
	| 'bad_list_id'
	| 'owner_conflict'
	| 'blocked'

export class TaskListError extends Error {
	override readonly name = 'TaskListError'
	constructor(
		readonly code: TaskListErrorCode,
		message: string,
	) {
		super(message)
	}
}

/** A store whose tasks several sessions share: it can say why a claim was refused. */
export interface ClaimableTaskStore extends TaskStore {
	readonly shared: true
	claimTask(id: TaskId, owner: string): Promise<TaskClaimResult>
	/** Tasks that are not completed and block this one. */
	unresolvedBlockers(task: Task): Promise<TaskId[]>
}

export function isClaimableTaskStore(store: TaskStore): store is ClaimableTaskStore {
	return (store as Partial<ClaimableTaskStore>).shared === true
}

export interface FileTaskStoreConfig {
	/** The team name or the session id the list belongs to. */
	listId: string
	/** Default `<NAMZU_HOME>/tasks`. */
	rootDir?: string
	tenantId?: TenantId
	/** Injected so a test never depends on the clock; default blocks the thread. */
	sleep?: (ms: number) => void
	logger?: Logger
}

interface Stored extends Task {
	/** The place the high-water mark issued; the order of the list. */
	seq: number
}

const STATUS_ORDER: Record<TaskStatus, number> = {
	pending: 0,
	in_progress: 1,
	completed: 2,
	failed: 2,
}

const LIST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

const HIGH_WATER = '.highwatermark'

function strip(stored: Stored): Task {
	const { seq: _seq, ...task } = stored
	return task as Task
}

export class FileTaskStore implements ClaimableTaskStore {
	readonly shared = true as const
	readonly listId: string
	private readonly dir: string
	private readonly tenantId?: TenantId
	private readonly sleep: (ms: number) => void
	private readonly log: Logger
	private listeners: TaskEventListener[] = []

	constructor(config: FileTaskStoreConfig) {
		if (!LIST_ID.test(config.listId) || config.listId.includes('..')) {
			throw new TaskListError(
				'bad_list_id',
				`A task list id is letters, digits, "_", "-" and "." (up to 128, not starting with a symbol); got ${JSON.stringify(config.listId)}.`,
			)
		}
		this.listId = config.listId
		this.dir = join(config.rootDir ?? join(resolveNamzuHome(), 'tasks'), config.listId)
		this.tenantId = config.tenantId
		this.sleep = config.sleep ?? sleepSync
		this.log = resolveLogger(config.logger).child({ [SCOPE_ATTRIBUTE]: 'store/task/file' })
	}

	/** The directory this list lives in. */
	get directory(): string {
		return this.dir
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

	// ── files and locks ─────────────────────────────────────────────

	private ensureDir(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 })
	}

	private taskFile(id: TaskId): string {
		// The id is checked as an entity id before it names a file.
		return join(this.dir, `${asTaskId(id)}.json`)
	}

	private listLockTarget(): string {
		return join(this.dir, '.list')
	}

	private inList<T>(operation: () => T): T {
		this.ensureDir()
		return lockedSync(this.listLockTarget(), this.sleep, operation)
	}

	/** Run `operation` holding the lock of each task, taken in sorted order. */
	private inTasks<T>(ids: readonly TaskId[], operation: () => T): T {
		this.ensureDir()
		const sorted = [...new Set(ids)].sort()
		const step = (i: number): T => {
			const id = sorted[i]
			if (id === undefined) return operation()
			return lockedSync(this.taskFile(id), this.sleep, () => step(i + 1))
		}
		return step(0)
	}

	private readStored(id: TaskId): Stored | undefined {
		let raw: string
		try {
			raw = readFileSync(this.taskFile(id), 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
			throw error
		}
		try {
			const parsed = JSON.parse(raw) as Stored
			if (typeof parsed?.id !== 'string' || typeof parsed.seq !== 'number') return undefined
			return parsed
		} catch {
			this.log.error('Corrupt task JSON on disk', { 'namzu.task.id': id })
			return undefined
		}
	}

	private writeStored(stored: Stored): void {
		writeAtomicSync(this.taskFile(stored.id), `${JSON.stringify(stored)}\n`, this.sleep)
	}

	private allStored(): Stored[] {
		let names: string[]
		try {
			names = readdirSync(this.dir)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
			throw error
		}
		const out: Stored[] = []
		for (const name of names) {
			if (!name.endsWith('.json')) continue
			const stored = this.readStored(name.slice(0, -'.json'.length) as TaskId)
			if (stored) out.push(stored)
		}
		return out.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
	}

	/** Issue the next place in the list. Caller holds the list lock. */
	private issueSeq(): number {
		const file = join(this.dir, HIGH_WATER)
		let last = 0
		try {
			last = Number.parseInt(readFileSync(file, 'utf8').trim(), 10)
			if (!Number.isInteger(last) || last < 0) last = 0
		} catch {
			last = 0
		}
		// A lost or damaged mark never makes a place repeat: it is raised to the largest one in use.
		for (const stored of this.allStored()) last = Math.max(last, stored.seq)
		const next = last + 1
		writeAtomicSync(file, `${next}\n`, this.sleep)
		return next
	}

	// ── reads ───────────────────────────────────────────────────────

	async get(id: TaskId): Promise<Task | undefined> {
		const stored = this.readStored(id)
		return stored ? strip(stored) : undefined
	}

	/**
	 * Every task of the list, in list order. The list belongs to a team or session by its id, so a
	 * `sessionId` filter is not applied: tasks of every session that works from this list are shown.
	 */
	async list(filter?: { status?: TaskStatus; owner?: string; sessionId?: SessionId }): Promise<
		Task[]
	> {
		let tasks = this.allStored().map(strip)
		if (filter?.status) tasks = tasks.filter((t) => t.status === filter.status)
		if (filter?.owner) tasks = tasks.filter((t) => t.owner === filter.owner)
		return tasks
	}

	async unresolvedBlockers(task: Task): Promise<TaskId[]> {
		const out: TaskId[] = []
		for (const id of task.blockedBy) {
			const blocker = this.readStored(id)
			// A blocker that no longer exists was deleted, which removed the edge; a dangling one is not a wait.
			if (blocker && blocker.status !== 'completed') out.push(id)
		}
		return out
	}

	/**
	 * The lowest task nobody owns that is pending and unblocked: what an idle member takes next.
	 */
	async nextClaimable(): Promise<Task | undefined> {
		for (const stored of this.allStored()) {
			if (stored.status !== 'pending' || stored.owner !== undefined) continue
			if ((await this.unresolvedBlockers(stored)).length > 0) continue
			return strip(stored)
		}
		return undefined
	}

	// ── changes ─────────────────────────────────────────────────────

	async create(params: CreateTaskParams): Promise<Task> {
		const blockers = [...new Set(params.blockedBy ?? [])]
		const created = this.inList(() =>
			this.inTasks(blockers, () => {
				const touched: Stored[] = []
				for (const blockerId of blockers) {
					const blocker = this.readStored(blockerId)
					if (!blocker)
						throw new TaskListError('not_found', `Task ${blockerId} is not in this list.`)
				}
				const id = generateTaskId()
				const stored: Stored = {
					id,
					seq: this.issueSeq(),
					sessionId: asSessionId(params.sessionId),
					turnId: asTurnId(params.turnId),
					tenantId: params.tenantId ?? this.tenantId,
					subject: params.subject,
					description: params.description,
					activeForm: params.activeForm,
					status: 'pending',
					owner: params.owner,
					blocks: [],
					blockedBy: blockers,
					metadata: params.metadata ? { ...params.metadata } : undefined,
					createdAt: Date.now(),
				}
				for (const blockerId of blockers) {
					const blocker = this.readStored(blockerId)
					if (blocker && !blocker.blocks.includes(id)) {
						blocker.blocks.push(id)
						this.writeStored(blocker)
						touched.push(blocker)
					}
				}
				this.writeStored(stored)
				return { stored, touched }
			}),
		)
		for (const blocker of created.touched) {
			this.emit({
				type: 'task.updated',
				taskId: blocker.id,
				task: strip(blocker),
				timestamp: Date.now(),
			})
		}
		const task = strip(created.stored)
		this.log.info('Task created', {
			'namzu.task.id': task.id,
			'namzu.store.subject': params.subject,
			[NAMZU.TURN_ID]: task.turnId,
		})
		this.emit({ type: 'task.created', taskId: task.id, task, timestamp: Date.now() })
		return task
	}

	async update(id: TaskId, updates: UpdateTaskParams): Promise<Task | undefined> {
		const result = this.inTasks([id], () => {
			const task = this.readStored(id)
			if (!task) return undefined
			const previousStatus = task.status
			// A change here never takes a task from its owner (that is what a claim is for), and a task
			// that still waits on an unfinished blocker is not completed.
			if (updates.owner !== undefined && task.owner !== undefined && updates.owner !== task.owner) {
				throw new TaskListError(
					'owner_conflict',
					`Task ${id} is owned by ${task.owner}; it is not reassigned to ${updates.owner}.`,
				)
			}
			if (updates.status === 'completed' && previousStatus !== 'completed') {
				const waiting = task.blockedBy.filter((b) => {
					const blocker = this.readStored(b)
					return blocker !== undefined && blocker.status !== 'completed'
				})
				if (waiting.length > 0) {
					throw new TaskListError(
						'blocked',
						`Task ${id} is blocked by ${waiting.join(', ')}; finish those first.`,
					)
				}
			}
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
				STATUS_ORDER[updates.status] > STATUS_ORDER[previousStatus]
			) {
				task.status = updates.status
				if (updates.status === 'in_progress' && !task.startedAt) task.startedAt = Date.now()
				if (isTerminalTaskStatus(updates.status)) task.completedAt = Date.now()
			}
			this.writeStored(task)
			return { task, previousStatus }
		})
		if (!result) return undefined
		const task = strip(result.task)
		this.emit({
			type: 'task.updated',
			taskId: id,
			task,
			previousStatus: result.previousStatus,
			timestamp: Date.now(),
		})
		return task
	}

	async claimTask(id: TaskId, owner: string): Promise<TaskClaimResult> {
		const outcome = this.inTasks([id], (): TaskClaimResult => {
			const task = this.readStored(id)
			if (!task) return { ok: false, code: 'not_found' }
			if (isTerminalTaskStatus(task.status)) {
				return { ok: false, code: 'already_resolved', task: strip(task) }
			}
			if (task.owner !== undefined && task.owner !== owner) {
				return { ok: false, code: 'already_claimed', task: strip(task) }
			}
			// The same owner claiming again is not a second claim: it changes nothing.
			if (task.owner === owner && task.status === 'in_progress') {
				return { ok: true, task: strip(task) }
			}
			const waiting: TaskId[] = []
			for (const blockerId of task.blockedBy) {
				const blocker = this.readStored(blockerId)
				if (blocker && blocker.status !== 'completed') waiting.push(blockerId)
			}
			if (waiting.length > 0) {
				return { ok: false, code: 'blocked', task: strip(task), blockedBy: waiting }
			}
			task.owner = owner
			task.status = 'in_progress'
			task.startedAt ??= Date.now()
			this.writeStored(task)
			return { ok: true, task: strip(task) }
		})
		if (outcome.ok) {
			this.emit({ type: 'task.claimed', taskId: id, task: outcome.task, timestamp: Date.now() })
		}
		return outcome
	}

	async claim(id: TaskId, owner: string): Promise<Task | undefined> {
		const result = await this.claimTask(id, owner)
		return result.ok ? result.task : undefined
	}

	async block(blockerId: TaskId, blockedId: TaskId): Promise<void> {
		const changed = this.inList(() =>
			this.inTasks([blockerId, blockedId], () => {
				const blocker = this.readStored(blockerId)
				const blocked = this.readStored(blockedId)
				if (!blocker || !blocked) {
					throw new TaskListError(
						'not_found',
						`Task ${blocker ? blockedId : blockerId} is not in this list.`,
					)
				}
				if (blockerId === blockedId || this.reaches(blocked, blockerId)) {
					throw new TaskListError(
						'cycle',
						`Task ${blockedId} already waits on task ${blockerId}, directly or through other tasks; adding this would make them wait on each other.`,
					)
				}
				const out: Stored[] = []
				if (!blocker.blocks.includes(blockedId)) {
					blocker.blocks.push(blockedId)
					this.writeStored(blocker)
					out.push(blocker)
				}
				if (!blocked.blockedBy.includes(blockerId)) {
					blocked.blockedBy.push(blockerId)
					this.writeStored(blocked)
					out.push(blocked)
				}
				return out
			}),
		)
		const now = Date.now()
		for (const stored of changed) {
			this.emit({ type: 'task.updated', taskId: stored.id, task: strip(stored), timestamp: now })
		}
	}

	/** Whether `target` is reached from `from` by following `blocks` edges (the caller holds the list lock). */
	private reaches(from: Stored, target: TaskId): boolean {
		const seen = new Set<TaskId>([from.id])
		const queue = [...from.blocks]
		while (queue.length > 0) {
			const id = queue.shift() as TaskId
			if (id === target) return true
			if (seen.has(id)) continue
			seen.add(id)
			const next = this.readStored(id)
			if (next) queue.push(...next.blocks)
		}
		return false
	}

	async delete(id: TaskId): Promise<boolean> {
		const outcome = this.inList(() => {
			const preview = this.readStored(id)
			if (!preview) return undefined
			return this.inTasks([id, ...preview.blockedBy, ...preview.blocks], () => {
				const task = this.readStored(id)
				if (!task) return undefined
				const touched: Stored[] = []
				for (const other of task.blockedBy) {
					const stored = other === id ? undefined : this.readStored(other)
					if (stored?.blocks.includes(id)) {
						stored.blocks = stored.blocks.filter((x) => x !== id)
						this.writeStored(stored)
						touched.push(stored)
					}
				}
				for (const other of task.blocks) {
					const stored = other === id ? undefined : this.readStored(other)
					if (stored?.blockedBy.includes(id)) {
						stored.blockedBy = stored.blockedBy.filter((x) => x !== id)
						this.writeStored(stored)
						touched.push(stored)
					}
				}
				removeSync(this.taskFile(id), this.sleep)
				return { task, touched }
			})
		})
		if (!outcome) return false
		for (const stored of outcome.touched) {
			this.emit({
				type: 'task.updated',
				taskId: stored.id,
				task: strip(stored),
				timestamp: Date.now(),
			})
		}
		this.emit({
			type: 'task.deleted',
			taskId: id,
			task: strip(outcome.task),
			timestamp: Date.now(),
		})
		return true
	}

	/**
	 * Empty the list, only when every task in it is completed: other work is never thrown away by a
	 * reset. The high-water mark stays, so places are not reissued.
	 */
	async reset(): Promise<void> {
		this.inList(() => {
			const all = this.allStored()
			const open = all.filter((t) => t.status !== 'completed')
			if (open.length > 0) {
				throw new TaskListError(
					'not_all_completed',
					`${open.length} task${open.length === 1 ? ' is' : 's are'} not completed; the list is only reset when all of them are.`,
				)
			}
			this.inTasks(
				all.map((t) => t.id),
				() => {
					for (const t of all) removeSync(this.taskFile(t.id), this.sleep)
				},
			)
		})
	}

	/** Whether the list's directory exists yet. */
	exists(): boolean {
		return existsSync(this.dir)
	}
}
