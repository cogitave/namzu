import { randomUUID } from 'node:crypto'
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * The cross-session screen lease: one file that says which session may use
 * the user's screen right now, so two sessions never interleave foreground
 * bursts.
 *
 * A lease is stale, and may be taken over, when its owner process is gone,
 * when a process with that id exists but started at another time (the id was
 * reused), or when nobody refreshed it within the time-to-live. The last rule
 * covers owners on a machine this process cannot inspect.
 */

export interface LeaseRecord {
	readonly pid: number
	/** The owner's process start time as the OS reports it; absent where unknown. */
	readonly identity?: string
	readonly session: string
	readonly token: string
	readonly acquiredAt: number
	readonly heartbeatAt: number
}

/** The file operations the lease needs; replaced in tests. */
export interface LeaseFs {
	/** Creates the file with `text`; false when it already exists. */
	createExclusive(path: string, text: string): boolean
	read(path: string): string | undefined
	remove(path: string): void
	rename(from: string, to: string): void
	/** Replaces the text of an existing file. */
	overwrite(path: string, text: string): void
}

export const realLeaseFs: LeaseFs = {
	createExclusive(path, text) {
		mkdirSync(dirname(path), { recursive: true })
		let fd: number
		try {
			fd = openSync(path, 'wx')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
			throw error
		}
		try {
			writeSync(fd, text)
		} finally {
			closeSync(fd)
		}
		return true
	},
	read(path) {
		try {
			return readFileSync(path, 'utf8')
		} catch {
			return undefined
		}
	},
	remove(path) {
		try {
			unlinkSync(path)
		} catch {
			// Already gone.
		}
	},
	rename(from, to) {
		renameSync(from, to)
	},
	overwrite(path, text) {
		// Write beside it and rename over it: a contender reading meanwhile sees
		// the old whole record or the new one, never an empty file.
		const temp = `${path}.tmp-${process.pid}`
		const fd = openSync(temp, 'w')
		try {
			writeSync(fd, text)
		} finally {
			closeSync(fd)
		}
		renameSync(temp, path)
	},
}

/** `/proc/<pid>/stat` field 22 (start time in ticks) on Linux; undefined elsewhere. */
export function processIdentity(pid: number): string | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
		const tail = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
		return tail[19]
	} catch {
		return undefined
	}
}

export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

export interface ScreenLeaseOptions {
	readonly path: string
	readonly session: string
	readonly now: () => number
	/** Milliseconds after the last refresh at which a lease is stale. Default 30 000. */
	readonly ttlMs?: number
	readonly pid?: number
	readonly fs?: LeaseFs
	readonly identity?: (pid: number) => string | undefined
	readonly alive?: (pid: number) => boolean
}

export type LeaseAttempt =
	| { readonly held: true; readonly token: string }
	| { readonly held: false; readonly owner: LeaseRecord | undefined }

export class ScreenLease {
	readonly path: string
	private readonly fs: LeaseFs
	private readonly ttlMs: number
	private readonly pid: number
	private readonly identity: (pid: number) => string | undefined
	private readonly alive: (pid: number) => boolean

	constructor(private readonly options: ScreenLeaseOptions) {
		this.path = options.path
		this.fs = options.fs ?? realLeaseFs
		this.ttlMs = options.ttlMs ?? 30_000
		this.pid = options.pid ?? process.pid
		this.identity = options.identity ?? processIdentity
		this.alive = options.alive ?? processAlive
	}

	/** One attempt. A stale lease is taken over; a live one is reported. */
	tryAcquire(): LeaseAttempt {
		const token = randomUUID()
		const now = this.options.now()
		const record: LeaseRecord = {
			pid: this.pid,
			...(this.identity(this.pid) !== undefined ? { identity: this.identity(this.pid) } : {}),
			session: this.options.session,
			token,
			acquiredAt: now,
			heartbeatAt: now,
		}
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.fs.createExclusive(this.path, JSON.stringify(record))) return { held: true, token }
			const owner = this.read()
			if (owner && !this.stale(owner)) return { held: false, owner }
			// Stale, or unreadable (half-written by a process that died): move it
			// aside so exactly one contender removes it, then look again.
			const aside = `${this.path}.stale-${token}`
			try {
				this.fs.rename(this.path, aside)
			} catch {
				continue
			}
			const taken = this.fs.read(aside)
			this.fs.remove(aside)
			if (taken !== undefined && owner === undefined) continue
			const movedOwner = taken === undefined ? undefined : parse(taken)
			if (movedOwner && owner && movedOwner.token !== owner.token) {
				// What was moved aside was a fresh lease someone took after our read.
				this.fs.createExclusive(this.path, taken as string)
				return { held: false, owner: movedOwner }
			}
		}
		return { held: false, owner: this.read() }
	}

	/** Marks the lease as alive. Returns false when it is no longer ours. */
	heartbeat(token: string): boolean {
		const owner = this.read()
		if (!owner || owner.token !== token) return false
		this.fs.overwrite(
			this.path,
			JSON.stringify({
				...owner,
				heartbeatAt: this.options.now(),
			} satisfies LeaseRecord),
		)
		return true
	}

	release(token: string): void {
		const owner = this.read()
		if (owner?.token === token) this.fs.remove(this.path)
	}

	read(): LeaseRecord | undefined {
		const text = this.fs.read(this.path)
		return text === undefined ? undefined : parse(text)
	}

	private stale(owner: LeaseRecord): boolean {
		if (this.options.now() - owner.heartbeatAt > this.ttlMs) return true
		if (owner.pid === this.pid) return false
		if (!this.alive(owner.pid)) return true
		if (owner.identity !== undefined) {
			const now = this.identity(owner.pid)
			if (now !== undefined && now !== owner.identity) return true
		}
		return false
	}
}

function parse(text: string): LeaseRecord | undefined {
	try {
		const value = JSON.parse(text) as Partial<LeaseRecord>
		if (
			typeof value.pid === 'number' &&
			typeof value.token === 'string' &&
			typeof value.heartbeatAt === 'number'
		)
			return value as LeaseRecord
	} catch {
		// Falls through.
	}
	return undefined
}
