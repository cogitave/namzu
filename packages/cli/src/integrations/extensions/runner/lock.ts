import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acquireOwnedLock, ownerLive, pidAlive, startTokenOf } from '../proc-start.js'
import { runnerDir } from '../signin/launcher.js'

/**
 * The one-runner-per-user lock, `_runner/lock`. The same format and takeover as the per-extension lock:
 * the pid and a start token (so a recycled pid is not mistaken for the owner), exclusive create, and a
 * takeover under a short mutex when the owner is gone.
 */

export interface LockBody {
	pid: number
	token: string
	kind: 'daemon'
	since: number
}

export { pidAlive as alive, startTokenOf }

export const runnerLockPath = (root: string): string => join(runnerDir(root), 'lock')

export function readRunnerLock(root: string): LockBody | undefined {
	try {
		return JSON.parse(readFileSync(runnerLockPath(root), 'utf8')) as LockBody
	} catch {
		return undefined
	}
}

/** The live owner of the runner lock, or undefined when there is none (or it is stale). */
export function liveRunner(root: string): LockBody | undefined {
	const cur = readRunnerLock(root)
	if (!cur) return undefined
	return ownerLive(cur) ? cur : undefined
}

export function acquireRunnerLock(root: string, now: number, pid = process.pid): boolean {
	const f = runnerLockPath(root)
	mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
	const mine: LockBody = {
		pid,
		token: startTokenOf(pid),
		kind: 'daemon',
		since: now,
	}
	return acquireOwnedLock(f, mine)
}

export function releaseRunnerLock(root: string, pid = process.pid): void {
	const cur = readRunnerLock(root)
	if (cur?.pid === pid) rmSync(runnerLockPath(root), { force: true })
}
