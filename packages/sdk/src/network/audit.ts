/**
 * The audit log of the Namzu network: one JSON object per line, append-only,
 * mode 0600, rotated once at 1 MiB. It records what happened and between whom,
 * never what was said: a message is represented by a hash prefix and a size,
 * and no key, token or certificate ever reaches a line.
 *
 * Writes go through an injected sink, so a host (or a test) decides where they
 * land; a failing sink is reported once and then ignored. It must never stop
 * the network.
 *
 * @experimental
 */

import { createHash } from 'node:crypto'
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const AUDIT_EVENTS = [
	'join_requested',
	'join_allowed',
	'join_denied',
	'join_expired',
	'admitted',
	'network_trusted',
	'network_untrusted',
	'removed',
	'role_set',
	'role_refused',
	'mail_accepted',
	'mail_held',
	'mail_allowed',
	'mail_denied',
	'mail_refused',
	'mail_expired',
	'network_on',
	'network_off',
	'machine_renamed',
	'connection_refused',
	'same_computer_unavailable',
	'same_computer_mismatch',
] as const
export type AuditEventName = (typeof AUDIT_EVENTS)[number]

export interface AuditEntry {
	readonly at: number
	readonly event: AuditEventName
	readonly machine?: { readonly id12: string; readonly name?: string }
	readonly session?: string
	/** `in`: another machine did it to this one; `out`: this machine did it to another. Absent for local events. */
	readonly direction?: 'in' | 'out'
	readonly decision?: string
	readonly reason?: string
	readonly bytes?: number
	readonly textHash?: string
}

export interface AuditSink {
	append(entry: AuditEntry): Promise<void>
}

/** First 16 hex of sha256 of the text: enough to match two records, useless to recover the words. */
export function textHash(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

export const AUDIT_ROTATE_BYTES = 1024 * 1024

export interface FileAuditSinkOptions {
	readonly dir: string
	readonly rotateBytes?: number
	/** Called once, with a plain sentence, when a write fails. */
	readonly report?: (message: string) => void
}

export const AUDIT_FILE = 'audit.jsonl'
export const AUDIT_BACKUP_FILE = 'audit.1.jsonl'

export function createFileAuditSink(options: FileAuditSinkOptions): AuditSink {
	const file = join(options.dir, AUDIT_FILE)
	const limit = options.rotateBytes ?? AUDIT_ROTATE_BYTES
	let reported = false
	let queue: Promise<void> = Promise.resolve()
	const write = async (entry: AuditEntry): Promise<void> => {
		try {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 })
			const size = await stat(file)
				.then((s) => s.size)
				.catch(() => 0)
			if (size >= limit) await rename(file, join(options.dir, AUDIT_BACKUP_FILE))
			await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
		} catch {
			if (!reported) {
				reported = true
				options.report?.('The Namzu network audit log could not be written.')
			}
		}
	}
	return {
		append(entry) {
			queue = queue.then(() => write(entry))
			return queue
		},
	}
}

/** A sink that keeps entries in memory. */
export function createMemoryAuditSink(): AuditSink & { readonly entries: AuditEntry[] } {
	const entries: AuditEntry[] = []
	return {
		entries,
		async append(entry) {
			entries.push(entry)
		},
	}
}
