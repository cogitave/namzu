/**
 * In-memory registry of sessions the daemon knows about. Each running namzu
 * process registers its session here (presence) and heartbeats; the
 * agent-view lists them. Sessions whose process has died or gone silent are
 * pruned so the list reflects what's actually live.
 */

import { pidAlive } from './discovery.js'

export type SessionState = 'idle' | 'thinking' | 'tool' | 'awaiting-permission' | 'exited'

export interface SessionRecord {
	readonly id: string
	title: string
	readonly cwd: string
	readonly pid: number
	model: string | null
	state: SessionState
	readonly startedAt: number
	lastSeen: number
}

export interface RegisterInput {
	readonly title?: string
	readonly cwd: string
	readonly pid: number
	readonly model?: string | null
}

/** A session is stale if its process is gone or it hasn't beat in this long. */
const HEARTBEAT_TTL_MS = 30_000

export class SessionRegistry {
	private sessions = new Map<string, SessionRecord>()
	private seq = 0

	register(input: RegisterInput): SessionRecord {
		const id = `sess_${Date.now().toString(36)}_${(this.seq++).toString(36)}`
		const now = Date.now()
		const rec: SessionRecord = {
			id,
			title: input.title ?? 'namzu session',
			cwd: input.cwd,
			pid: input.pid,
			model: input.model ?? null,
			state: 'idle',
			startedAt: now,
			lastSeen: now,
		}
		this.sessions.set(id, rec)
		return rec
	}

	update(
		id: string,
		patch: { title?: string; model?: string | null; state?: SessionState },
	): SessionRecord | null {
		const rec = this.sessions.get(id)
		if (!rec) return null
		if (patch.title !== undefined) rec.title = patch.title
		if (patch.model !== undefined) rec.model = patch.model
		if (patch.state !== undefined) rec.state = patch.state
		rec.lastSeen = Date.now()
		return rec
	}

	remove(id: string): boolean {
		return this.sessions.delete(id)
	}

	/** Live sessions, pruning any whose process died or went silent. */
	list(): SessionRecord[] {
		const now = Date.now()
		for (const [id, rec] of this.sessions) {
			if (!pidAlive(rec.pid) || now - rec.lastSeen > HEARTBEAT_TTL_MS) {
				this.sessions.delete(id)
			}
		}
		return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen)
	}

	count(): number {
		return this.list().length
	}
}
