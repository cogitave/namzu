import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'

/**
 * Who owns a lock file. A pid alone is not enough: after a restart the pid in an old lock is often
 * taken by an unrelated process. The start time of the process, as the system reports it, tells them
 * apart, and where it cannot be read the lock's own clock is compared with the time the computer
 * started.
 */

export const pidAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0)
		return true
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const ask = (cmd: string, args: string[]): string => {
	try {
		const r = spawnSync(cmd, args, {
			encoding: 'utf8',
			timeout: 5000,
			windowsHide: true,
			stdio: ['ignore', 'pipe', 'ignore'],
		})
		return r.status === 0 ? String(r.stdout).trim() : ''
	} catch {
		return ''
	}
}

/** The start time of a process as the system reports it; empty where it cannot be read. */
export function startTokenOf(pid: number, platform: NodeJS.Platform = process.platform): string {
	if (!Number.isInteger(pid) || pid <= 0) return ''
	if (platform === 'linux') {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
			return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? ''
		} catch {
			return ''
		}
	}
	if (platform === 'darwin') return ask('ps', ['-o', 'lstart=', '-p', String(pid)])
	if (platform === 'win32')
		return ask('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
		])
	return ''
}

const WIN_ARGS = (pid: number): string[] => [
	'-NoProfile',
	'-NonInteractive',
	'-Command',
	`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
]

/** The same question as `startTokenOf` on Windows, asked without blocking the event loop. */
export function startTokenOfAsync(
	pid: number,
	platform: NodeJS.Platform = process.platform,
): Promise<string> {
	if (platform !== 'win32') return Promise.resolve(startTokenOf(pid, platform))
	if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve('')
	return new Promise((resolve) => {
		try {
			execFile(
				'powershell.exe',
				WIN_ARGS(pid),
				{ encoding: 'utf8', timeout: 5000, windowsHide: true },
				(err, stdout) => resolve(err ? '' : String(stdout).trim()),
			)
		} catch {
			resolve('')
		}
	})
}

export interface StartTokenDeps {
	readonly alive?: (pid: number) => boolean
	/** The blocking read (cheap on Linux, a spawn elsewhere). */
	readonly read?: (pid: number) => string
	/** The non-blocking read; used by `peek` where the blocking one is a process spawn. */
	readonly readAsync?: (pid: number) => Promise<string>
	/** Whether `read` blocks on a spawn, so `peek` must not call it. Defaults to win32. */
	readonly slow?: boolean
	/** Called when a probe that `peek` started has answered, so a caller can look again. */
	readonly onResolved?: (pid: number, token: string) => void
}

export interface StartTokens {
	/**
	 * The token, from the cache or read now (blocking). Correct but may block for a process spawn on
	 * Windows: only for a pid that must be judged now (the host's own, a lock takeover's).
	 */
	strict(pid: number): string
	/**
	 * The token if known; otherwise `undefined` and, where reading blocks, an asynchronous probe has been
	 * started (one per pid however many callers ask). Never blocks on a spawn. Callers treat `undefined`
	 * as "not known yet".
	 */
	peek(pid: number): string | undefined
	/** Forget one pid, or all. */
	evict(pid?: number): void
	readonly size: number
}

/**
 * A pid's start time cannot change while the process lives, so it is read once per pid and kept. A pid
 * whose process is gone is dropped (the next owner of that pid gets a fresh read), and so is one whose
 * probe found nothing alive.
 */
export function createStartTokens(deps: StartTokenDeps = {}): StartTokens {
	const alive = deps.alive ?? pidAlive
	const read = deps.read ?? ((pid: number) => startTokenOf(pid))
	const slow = deps.slow ?? process.platform === 'win32'
	const readAsync = deps.readAsync ?? ((pid: number) => startTokenOfAsync(pid))
	const known = new Map<number, string>()
	const pending = new Map<number, Promise<void>>()
	const cached = (pid: number): string | undefined => {
		const t = known.get(pid)
		if (t === undefined) return undefined
		if (alive(pid)) return t
		known.delete(pid)
		return undefined
	}
	return {
		strict(pid) {
			const hit = cached(pid)
			if (hit !== undefined) return hit
			const t = read(pid)
			if (alive(pid)) known.set(pid, t)
			return t
		},
		peek(pid) {
			const hit = cached(pid)
			if (hit !== undefined) return hit
			if (!slow) {
				const t = read(pid)
				if (alive(pid)) known.set(pid, t)
				return t
			}
			if (!pending.has(pid)) {
				const probe = readAsync(pid)
					.then((t) => {
						if (alive(pid)) known.set(pid, t)
						deps.onResolved?.(pid, t)
					})
					.catch(() => undefined)
					.finally(() => pending.delete(pid))
				pending.set(pid, probe)
			}
			return undefined
		},
		evict(pid) {
			if (pid === undefined) known.clear()
			else known.delete(pid)
		},
		get size() {
			return known.size
		},
	}
}

/** True when a lock written at `since` is older than the last start of the computer (so its pid was reused). */
export function writtenBeforeBoot(
	since: number,
	now: number = Date.now(),
	uptimeSeconds: number = uptime(),
): boolean {
	return since < now - uptimeSeconds * 1000 - 5000
}

export interface LockOwner {
	readonly pid: number
	readonly token: string
	readonly since?: number
}

/**
 * Whether the process a lock names is still its owner. Equal start times prove it. Where the system
 * gives none (both empty), a lock that is older than this boot is stale.
 */
export function ownerLive(
	o: LockOwner,
	deps: {
		alive?: (pid: number) => boolean
		startTokenOf?: (pid: number) => string
		now?: number
		uptimeSeconds?: number
	} = {},
): boolean {
	if (!(deps.alive ?? pidAlive)(o.pid)) return false
	const tok = (deps.startTokenOf ?? startTokenOf)(o.pid)
	if (tok !== o.token) return false
	if (
		tok === '' &&
		typeof o.since === 'number' &&
		writtenBeforeBoot(o.since, deps.now, deps.uptimeSeconds)
	)
		return false
	return true
}

const GATE_STALE_MS = 10_000

function takeGate(gate: string): boolean {
	for (let i = 0; i < 2; i++) {
		try {
			mkdirSync(gate, { mode: 0o700 })
			return true
		} catch {
			// held by another process, or left behind by one that died inside it
		}
		try {
			if (Date.now() - statSync(gate).mtimeMs <= GATE_STALE_MS) return false
			rmSync(gate, { recursive: true, force: true })
		} catch {
			// gone already: try to take it
		}
	}
	return false
}

/**
 * Take the lock file `file` for `mine`: an exclusive create when there is none, and when there is
 * one, a takeover only if its owner is gone. The takeover runs under a short mutex (an exclusively
 * created folder) so that of two processes that both saw the same stale lock, one replaces it and the
 * other sees the result and backs off.
 */
export function acquireOwnedLock<T extends LockOwner>(file: string, mine: T): boolean {
	const body = JSON.stringify(mine)
	try {
		writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
		return true
	} catch {
		// a lock file exists: a live owner, or a stale one to take over
	}
	const gate = `${file}.takeover`
	if (!takeGate(gate)) return false
	try {
		for (let attempt = 0; attempt < 3; attempt++) {
			let cur: LockOwner | undefined
			try {
				cur = JSON.parse(readFileSync(file, 'utf8')) as LockOwner
			} catch {
				cur = undefined // unreadable counts as stale
			}
			if (cur?.pid === mine.pid) return true
			if (cur && ownerLive(cur)) return false
			rmSync(file, { force: true })
			try {
				writeFileSync(file, body, { mode: 0o600, flag: 'wx' })
				return true
			} catch {
				// a process that did not need the gate created it first: judge that lock next
			}
		}
		return false
	} finally {
		rmSync(gate, { recursive: true, force: true })
	}
}
