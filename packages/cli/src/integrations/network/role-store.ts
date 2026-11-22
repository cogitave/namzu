import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionRole, SessionRoleStore } from '../peers/runtime.js'

/**
 * Roles of sessions on this machine, kept in `<home>/network/session-roles.json` so a role survives a resume
 * and reaches a terminal that is not the one running the network service. A role is a description; nothing
 * here, or anywhere it is read, treats it as permission.
 *
 * Keyed by the conversation id; a session with no conversation yet is keyed `ref:<ref>`. The most recent 64
 * are kept. Reads are cached by modification time, so a terminal can ask on every publish. Nothing throws:
 * an unreadable file is an empty store.
 */

const FILE = 'session-roles.json'
const MAX_ROLES = 64
const MAX_ROLE_BYTES = 500

interface StoredRole {
	conversationId: string
	role: string
	by: string
	at: number
}

export interface RoleFileStore extends SessionRoleStore {
	/** False when the role could not be kept. */
	write(key: string, role: SessionRole | null): boolean
}

export function createRoleStore(options: { readonly home: string }): RoleFileStore {
	const dir = join(options.home, 'network')
	const path = join(dir, FILE)
	let cache:
		| { readonly mtimeMs: number; readonly size: number; readonly roles: StoredRole[] }
		| undefined

	const load = (): StoredRole[] => {
		let info: ReturnType<typeof statSync>
		try {
			info = statSync(path)
		} catch {
			cache = undefined
			return []
		}
		if (cache && cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.roles
		let roles: StoredRole[] = []
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as { v?: unknown; roles?: unknown }
			if (parsed.v === 1 && Array.isArray(parsed.roles)) {
				roles = parsed.roles.filter(
					(entry): entry is StoredRole =>
						typeof entry === 'object' &&
						entry !== null &&
						typeof (entry as StoredRole).conversationId === 'string' &&
						typeof (entry as StoredRole).role === 'string' &&
						(entry as StoredRole).role.length > 0 &&
						Buffer.byteLength((entry as StoredRole).role, 'utf8') <= MAX_ROLE_BYTES &&
						typeof (entry as StoredRole).by === 'string' &&
						Number.isInteger((entry as StoredRole).at),
				)
			}
		} catch {
			roles = []
		}
		cache = { mtimeMs: info.mtimeMs, size: info.size, roles }
		return roles
	}

	return {
		read(key) {
			const found = load().find((entry) => entry.conversationId === key)
			return found ? { role: found.role, by: found.by, at: found.at } : undefined
		},
		write(key, role) {
			try {
				const rest = load().filter((entry) => entry.conversationId !== key)
				const next = role
					? [...rest, { conversationId: key, role: role.role, by: role.by, at: role.at }]
					: rest
				mkdirSync(dir, { recursive: true, mode: 0o700 })
				const temp = `${path}.${process.pid}.tmp`
				writeFileSync(temp, `${JSON.stringify({ v: 1, roles: next.slice(-MAX_ROLES) })}\n`, {
					mode: 0o600,
				})
				renameSync(temp, path)
				cache = undefined
				return true
			} catch {
				return false
			}
		},
	}
}
