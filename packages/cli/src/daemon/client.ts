/**
 * Thin client for the namzu daemon. Used by the TUI to register its presence
 * (so an agent-view in another terminal can see it) and to list sessions.
 * Every call is best-effort: if no daemon is running, the helpers no-op /
 * return empty, so the TUI works exactly the same with or without `namzu serve`.
 */

import { type DaemonInfo, pidAlive, readDaemonInfo } from './discovery.js'
import type { SessionRecord, SessionState } from './registry.js'

const TIMEOUT_MS = 1_500

/** The running daemon's connection info, or null if none is reachable. */
function liveDaemon(): DaemonInfo | null {
	const info = readDaemonInfo()
	if (!info || !pidAlive(info.pid)) return null
	return info
}

async function call(
	info: DaemonInfo,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response | null> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
	try {
		return await fetch(`http://${info.host}:${info.port}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${info.token}`,
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			signal: controller.signal,
		})
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

export interface RegisterSessionInput {
	readonly cwd: string
	readonly title?: string
	readonly model?: string | null
}

/** Register this process as a session; returns the daemon's id, or null. */
export async function registerSession(input: RegisterSessionInput): Promise<string | null> {
	const info = liveDaemon()
	if (!info) return null
	const res = await call(info, 'POST', '/v1/sessions', { ...input, pid: process.pid })
	if (!res || !res.ok) return null
	try {
		const rec = (await res.json()) as { id?: string }
		return typeof rec.id === 'string' ? rec.id : null
	} catch {
		return null
	}
}

export async function heartbeatSession(
	id: string,
	patch: { state?: SessionState; title?: string; model?: string | null },
): Promise<void> {
	const info = liveDaemon()
	if (!info) return
	await call(info, 'PUT', `/v1/sessions/${encodeURIComponent(id)}`, patch)
}

export async function deregisterSession(id: string): Promise<void> {
	const info = liveDaemon()
	if (!info) return
	await call(info, 'DELETE', `/v1/sessions/${encodeURIComponent(id)}`)
}

/** List sessions the daemon knows about (empty when no daemon is running). */
export async function listDaemonSessions(): Promise<readonly SessionRecord[]> {
	const info = liveDaemon()
	if (!info) return []
	const res = await call(info, 'GET', '/v1/sessions')
	if (!res || !res.ok) return []
	try {
		const body = (await res.json()) as { sessions?: SessionRecord[] }
		return Array.isArray(body.sessions) ? body.sessions : []
	} catch {
		return []
	}
}

export function daemonRunning(): boolean {
	return liveDaemon() !== null
}
