import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One terminal per machine runs the Namzu network service: it owns the listener and the advertisement.
 * The others find it through `leader.lock` and ask it over the control channel. The lock holds the
 * leader's process id; a lock whose process is gone is taken over. Every terminal looks again every few
 * seconds, so when the leader closes, another takes over within one tick.
 */

export interface LeaderLock {
	readonly pid: number
	readonly startedAt: number
}

export interface LeadershipOptions {
	/** `<home>/network`; created private (0700) when missing. */
	readonly dir: string
	readonly pid: number
	readonly now: () => number
	/** Whether a process exists. Injected so tests need no real processes. */
	readonly isAlive: (pid: number) => boolean
	/** Make the directory private; the terminal supplies the one that also covers a Windows ACL. */
	readonly harden?: (path: string) => void
}

export interface Leadership {
	/** Try to become the leader (or confirm being it). Returns whether this process leads now. */
	tryAcquire(): boolean
	/** Who holds the lock, if anyone alive does. */
	holder(): LeaderLock | undefined
	readonly isLeader: boolean
	/** Give the lock up; only ever removes a lock this process wrote. */
	release(): void
}

const LOCK_FILE = 'leader.lock'

export function readLock(dir: string): LeaderLock | undefined {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, LOCK_FILE), 'utf8')) as Partial<LeaderLock>
		if (Number.isInteger(parsed.pid) && (parsed.pid as number) > 0)
			return { pid: parsed.pid as number, startedAt: Number(parsed.startedAt) || 0 }
	} catch {
		// missing or unreadable: nobody leads
	}
	return undefined
}

export function createLeadership(options: LeadershipOptions): Leadership {
	const path = join(options.dir, LOCK_FILE)
	let leader = false
	const acquire = (): boolean => {
		mkdirSync(options.dir, { recursive: true, mode: 0o700 })
		options.harden?.(options.dir)
		if (write()) return true
		const held = readLock(options.dir)
		if (held?.pid === options.pid) return true
		if (held && options.isAlive(held.pid)) return false
		// The leader is gone (or left a lock nobody can read): take over. Of two terminals that do it at once,
		// only one wins the exclusive create below; the other sees a live holder on its next look.
		// Look once more right before removing: a taker that was faster has written a live lock by now.
		const again = readLock(options.dir)
		if (again && again.pid !== held?.pid && options.isAlive(again.pid))
			return again.pid === options.pid
		try {
			unlinkSync(path)
		} catch {
			// already removed by the other taker
		}
		return write()
	}
	const write = (): boolean => {
		try {
			const fd = openSync(path, 'wx', 0o600)
			try {
				writeSync(fd, `${JSON.stringify({ pid: options.pid, startedAt: options.now() })}\n`)
			} finally {
				closeSync(fd)
			}
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
			throw error
		}
	}
	return {
		tryAcquire() {
			leader = acquire()
			return leader
		},
		holder() {
			const held = readLock(options.dir)
			return held && options.isAlive(held.pid) ? held : undefined
		},
		get isLeader() {
			return leader
		},
		release() {
			if (!leader) return
			leader = false
			if (readLock(options.dir)?.pid === options.pid) {
				try {
					unlinkSync(path)
				} catch {
					// already gone
				}
			}
		},
	}
}

/** Whether a process exists on this machine (signal 0 checks without sending anything). */
export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}
