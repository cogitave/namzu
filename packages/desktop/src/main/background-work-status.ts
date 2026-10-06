import type {
	BackgroundWorkStatus,
	BackgroundWorkStatusEvent,
} from '../shared/background-work-protocol.js'

/** These reads are UI observations, never permission or cleanup evidence. */
export interface BackgroundWorkOwner {
	readonly projectId: string
	readonly sessionId: string
	readonly runtimeSessionId: string
	readonly connection: object
}

interface Entry {
	readonly owner: BackgroundWorkOwner
	readonly read: () => Promise<unknown>
	readonly current: () => boolean
	status: BackgroundWorkStatus
	nextReadAt: number
	failures: number
	refreshAfterRead: boolean
}

const TICK_MS = 1_000
const MIN_READ_GAP_MS = 2_000
const RETRY_MS = 5_000
const FRESH_MS = 15_000
const MAX_ENTRIES = 64
const MAX_RETRIES = 3

function sameOwner(a: BackgroundWorkOwner, b: BackgroundWorkOwner): boolean {
	return (
		a.projectId === b.projectId &&
		a.sessionId === b.sessionId &&
		a.runtimeSessionId === b.runtimeSessionId &&
		a.connection === b.connection
	)
}

/** Only exact registry state is summarized; commands and output never cross this event. */
export function summarizeBackgroundWork(rows: unknown, now: number): BackgroundWorkStatus {
	if (
		!Array.isArray(rows) ||
		rows.length > 4_096 ||
		rows.some(
			(row) =>
				!row ||
				typeof row !== 'object' ||
				typeof row.id !== 'string' ||
				!row.id ||
				!['running', 'exited', 'killed'].includes(row.status) ||
				!Number.isSafeInteger(row.startedAt) ||
				row.startedAt < 0 ||
				(row.recoveryRequired !== undefined && typeof row.recoveryRequired !== 'boolean') ||
				(row.recoveryRequired === true && row.status !== 'running') ||
				(row.exitCode !== undefined && !Number.isSafeInteger(row.exitCode)),
		) ||
		new Set(rows.map((row) => row.id)).size !== rows.length
	)
		return { state: 'unknown' }
	return {
		state: 'known',
		runningCount: rows.filter((row) => row.status === 'running').length,
		needsAttention: rows.some(
			(row) =>
				row.recoveryRequired === true ||
				(row.status === 'exited' && row.exitCode !== undefined && row.exitCode !== 0),
		),
		checkedAt: now,
		expiresAt: now + FRESH_MS,
	}
}

/** One serialized main-process observer shared by every Desktop window. */
export class BackgroundWorkStatusTracker {
	private readonly entries = new Map<string, Entry>()
	private timer?: ReturnType<typeof setInterval>
	private reading = false
	private readingEntry?: Entry
	private nextGlobalReadAt = 0
	private closed = false

	constructor(private readonly publish: (event: BackgroundWorkStatusEvent) => void) {}

	snapshot(): Record<string, BackgroundWorkStatus> {
		const now = Date.now()
		return Object.fromEntries(
			[...this.entries].map(([id, entry]) => [
				id,
				entry.status.state === 'known' && now >= entry.status.expiresAt
					? { state: 'unknown' }
					: entry.status,
			]),
		)
	}

	/** Trigger after a tool/turn settles or an ordinary conversation is opened. */
	observe(owner: BackgroundWorkOwner, read: () => Promise<unknown>, current: () => boolean): void {
		if (this.closed || !current()) return
		const existing = this.entries.get(owner.sessionId)
		if (existing && sameOwner(existing.owner, owner)) {
			if (this.readingEntry === existing) existing.refreshAfterRead = true
			// A currently confirmed snapshot is enough until its minimum read gap.
			existing.nextReadAt = Math.min(
				existing.nextReadAt,
				existing.status.state === 'known'
					? existing.status.checkedAt + MIN_READ_GAP_MS
					: Date.now(),
			)
		} else {
			this.put({
				owner,
				read,
				current,
				status: { state: 'unknown' },
				nextReadAt: Date.now(),
				failures: 0,
				refreshAfterRead: false,
			})
		}
		this.ensureTimer()
		this.tick()
	}

	invalidate(sessionId: string, status: BackgroundWorkStatus = { state: 'unknown' }): void {
		const entry = this.entries.get(sessionId)
		if (!entry) return
		this.entries.delete(sessionId)
		if (!this.closed)
			this.publish({
				kind: 'background-work-status',
				projectId: entry.owner.projectId,
				sessionId,
				status,
			})
		this.ensureTimer()
	}

	invalidateProject(projectId: string): void {
		for (const entry of [...this.entries.values()])
			if (entry.owner.projectId === projectId) this.invalidate(entry.owner.sessionId)
	}

	close(): void {
		this.closed = true
		if (this.timer) clearInterval(this.timer)
		this.timer = undefined
		this.entries.clear()
	}

	private put(entry: Entry): void {
		if (this.entries.has(entry.owner.sessionId)) this.invalidate(entry.owner.sessionId)
		if (this.entries.size >= MAX_ENTRIES) {
			const oldest = [...this.entries.values()].find(
				(item) => item.status.state !== 'known' || item.status.runningCount === 0,
			)
			this.invalidate((oldest ?? this.entries.values().next().value)?.owner.sessionId ?? '')
		}
		this.entries.set(entry.owner.sessionId, entry)
	}

	private publishRows(entry: Entry, rows: unknown): void {
		const status = summarizeBackgroundWork(rows, Date.now())
		entry.status = status
		entry.failures = status.state === 'known' ? 0 : entry.failures + 1
		entry.nextReadAt =
			status.state === 'known'
				? status.runningCount > 0
					? status.checkedAt + MIN_READ_GAP_MS
					: Number.POSITIVE_INFINITY
				: entry.failures < MAX_RETRIES
					? Date.now() + RETRY_MS
					: Number.POSITIVE_INFINITY
		if (entry.refreshAfterRead) {
			entry.nextReadAt = Math.min(entry.nextReadAt, Date.now() + MIN_READ_GAP_MS)
			entry.refreshAfterRead = false
		}
		this.publish({
			kind: 'background-work-status',
			projectId: entry.owner.projectId,
			sessionId: entry.owner.sessionId,
			status,
		})
		this.ensureTimer()
	}

	private ensureTimer(): void {
		const active = [...this.entries.values()].some(
			(entry) => Number.isFinite(entry.nextReadAt) || entry.status.state === 'known',
		)
		if (active && !this.timer && !this.closed) {
			this.timer = setInterval(() => this.tick(), TICK_MS)
			this.timer.unref?.()
		} else if (!active && this.timer) {
			clearInterval(this.timer)
			this.timer = undefined
		}
	}

	private tick(): void {
		if (this.closed) return
		const now = Date.now()
		for (const entry of [...this.entries.values()]) {
			if (!entry.current()) {
				this.invalidate(entry.owner.sessionId)
				continue
			}
			if (entry.status.state === 'known' && now >= entry.status.expiresAt) {
				entry.status = { state: 'unknown' }
				this.publish({
					kind: 'background-work-status',
					projectId: entry.owner.projectId,
					sessionId: entry.owner.sessionId,
					status: entry.status,
				})
				if (entry.nextReadAt === Number.POSITIVE_INFINITY && this.readingEntry !== entry)
					this.entries.delete(entry.owner.sessionId)
			}
		}
		if (this.reading || now < this.nextGlobalReadAt) {
			this.ensureTimer()
			return
		}
		const due = [...this.entries.values()]
			.filter((entry) => entry.nextReadAt <= now)
			.sort((a, b) => a.nextReadAt - b.nextReadAt)[0]
		if (!due) {
			this.ensureTimer()
			return
		}
		this.reading = true
		this.readingEntry = due
		due.nextReadAt = Number.POSITIVE_INFINITY
		void Promise.resolve()
			.then(() => due.read())
			.then(
				(rows) => {
					if (this.entries.get(due.owner.sessionId) === due && due.current())
						this.publishRows(due, rows)
				},
				() => {
					if (this.entries.get(due.owner.sessionId) !== due || !due.current()) return
					due.status = { state: 'unknown' }
					due.failures += 1
					due.nextReadAt =
						due.failures < MAX_RETRIES ? Date.now() + RETRY_MS : Number.POSITIVE_INFINITY
					this.publish({
						kind: 'background-work-status',
						projectId: due.owner.projectId,
						sessionId: due.owner.sessionId,
						status: due.status,
					})
				},
			)
			.finally(() => {
				this.reading = false
				this.readingEntry = undefined
				this.nextGlobalReadAt = Date.now() + TICK_MS
				this.ensureTimer()
			})
	}
}
