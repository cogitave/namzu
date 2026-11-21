import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * One terminal per machine runs the Namzu network service: it owns the listener and the advertisement.
 * The others find it through `leader.lock` and ask it over the control channel. The lock holds the
 * leader's process id and the time it last looked; a lock whose process is gone, or that was not renewed
 * for {@link LOCK_STALE_MS} (a process id the system handed to something else after a restart, a leader
 * that was frozen), is taken over. Every terminal looks again every few
 * seconds, so when the leader closes, another takes over within one tick.
 */

export interface LeaderLock {
	readonly pid: number
	readonly startedAt: number
	/** The last time the holder renewed the lock; a lock nobody renewed lately is nobody's. */
	readonly beatAt: number
}

/** A leader renews its lock every tick (5 s); one not renewed for this long is gone, whatever its pid says. */
export const LOCK_STALE_MS = 30_000

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
			return {
				pid: parsed.pid as number,
				startedAt: Number(parsed.startedAt) || 0,
				beatAt: Number(parsed.beatAt) || Number(parsed.startedAt) || 0,
			}
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
		if (held?.pid === options.pid) {
			renew()
			return true
		}
		if (held && alive(held)) return false
		// The leader is gone (or left a lock nobody can read): take over. Of two terminals that do it at once,
		// only one wins the exclusive create below; the other sees a live holder on its next look.
		// Look once more right before removing: a taker that was faster has written a live lock by now.
		const again = readLock(options.dir)
		if (again && again.pid !== held?.pid && alive(again)) return again.pid === options.pid
		try {
			unlinkSync(path)
		} catch {
			// already removed by the other taker
		}
		return write()
	}
	/** A process that exists and has renewed its lock lately: a pid alone proves nothing after a restart. */
	const alive = (lock: LeaderLock): boolean =>
		options.isAlive(lock.pid) && options.now() - lock.beatAt <= LOCK_STALE_MS
	/** Say again that this process still leads: a finished file moved over the lock in one step. */
	const renew = (): void => {
		const temp = `${path}.${options.pid}.beat`
		try {
			const lock = readLock(options.dir)
			writeFileSync(
				temp,
				`${JSON.stringify({ pid: options.pid, startedAt: lock?.startedAt ?? options.now(), beatAt: options.now() })}\n`,
				{ mode: 0o600 },
			)
			renameSync(temp, path)
		} catch {
			try {
				unlinkSync(temp)
			} catch {
				// not there
			}
		}
	}
	const write = (): boolean => {
		// The lock appears with its content in one step (a hard link of a finished file), so a reader never
		// sees an empty lock and takes it for a gone leader.
		const temp = `${path}.${options.pid}.tmp`
		try {
			writeFileSync(
				temp,
				`${JSON.stringify({ pid: options.pid, startedAt: options.now(), beatAt: options.now() })}\n`,
				{
					mode: 0o600,
				},
			)
			linkSync(temp, path)
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
			throw error
		} finally {
			try {
				unlinkSync(temp)
			} catch {
				// not there
			}
		}
	}
	return {
		tryAcquire() {
			leader = acquire()
			return leader
		},
		holder() {
			const held = readLock(options.dir)
			return held && alive(held) ? held : undefined
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
