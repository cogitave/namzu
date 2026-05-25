/**
 * Daemon discovery: a single well-known file at `~/.namzu/daemon.json` that
 * advertises a running `namzu serve` instance (host/port + auth token) so
 * any namzu process can find and talk to it. Written on startup, removed on
 * shutdown; a stale file (dead pid / unreachable) is treated as absent.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface DaemonInfo {
	readonly pid: number
	readonly host: string
	readonly port: number
	readonly token: string
	readonly version: string
	readonly startedAt: number
}

export function daemonDir(): string {
	return join(homedir(), '.namzu')
}

export function daemonInfoPath(): string {
	return join(daemonDir(), 'daemon.json')
}

export function writeDaemonInfo(info: DaemonInfo): void {
	mkdirSync(daemonDir(), { recursive: true })
	writeFileSync(daemonInfoPath(), `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
}

export function readDaemonInfo(): DaemonInfo | null {
	try {
		const raw = readFileSync(daemonInfoPath(), 'utf8')
		const parsed = JSON.parse(raw) as Partial<DaemonInfo>
		if (
			typeof parsed.pid === 'number' &&
			typeof parsed.host === 'string' &&
			typeof parsed.port === 'number' &&
			typeof parsed.token === 'string'
		) {
			return parsed as DaemonInfo
		}
		return null
	} catch {
		return null
	}
}

export function removeDaemonInfo(): void {
	try {
		rmSync(daemonInfoPath(), { force: true })
	} catch {
		// best-effort
	}
}

/** Whether a pid is currently alive (signal 0 probe). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		// EPERM means it exists but we can't signal it — still alive.
		return (err as NodeJS.ErrnoException).code === 'EPERM'
	}
}
