/**
 * The live-session registry: one JSON file per participating session under a
 * hardened runtime directory's `sessions/` subdirectory (design §1.2).
 *
 * @experimental
 */

import { randomBytes } from 'node:crypto'
import {
	closeSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	unlinkSync,
	writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parsePeerAddress } from './address.js'
import { pingPeer } from './client.js'
import { type PeerRecord, PeerRecordSchema } from './record.js'

const RECORD_FILE_MODE = 0o600

export class PeerRegistryError extends Error {
	override readonly name = 'PeerRegistryError'
}

function recordPath(sessionsDir: string, sessionId: string): string {
	return join(sessionsDir, `${sessionId}.json`)
}

function temporaryPathBeside(path: string): string {
	return join(
		dirname(path),
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
	)
}

/** Publish `record` at `<sessionsDir>/<sessionId>.json`: fsynced temporary, then rename, mode 0600. */
export function writePeerRecord(sessionsDir: string, record: PeerRecord): void {
	const validated = PeerRecordSchema.safeParse(record)
	if (!validated.success) {
		throw new PeerRegistryError(`Invalid peer record: ${validated.error.message}`)
	}
	const parsed = validated.data
	const path = recordPath(sessionsDir, parsed.sessionId)
	const temporary = temporaryPathBeside(path)
	const fd = openSync(temporary, 'wx', RECORD_FILE_MODE)
	try {
		writeSync(fd, `${JSON.stringify(parsed)}\n`)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	try {
		renameSync(temporary, path)
	} catch (error) {
		try {
			unlinkSync(temporary)
		} catch {
			// The rename already failed; a leftover temporary file is not this
			// call's failure to report.
		}
		throw error
	}
}

function parseRecordText(text: string): PeerRecord | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch {
		return undefined
	}
	const result = PeerRecordSchema.safeParse(parsed)
	return result.success ? result.data : undefined
}

/** One session's record, or `undefined` if it has none or its file does not parse. */
export function readPeerRecord(sessionsDir: string, sessionId: string): PeerRecord | undefined {
	let text: string
	try {
		text = readFileSync(recordPath(sessionsDir, sessionId), 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
		throw error
	}
	return parseRecordText(text)
}

/**
 * Every registry record in `sessionsDir` that parses.
 *
 * A file that fails to parse (mid-write, truncated, from a newer namzu) is
 * skipped rather than thrown on: one malformed record must not make every
 * other live session invisible to `list_sessions`.
 */
export function readPeerRecords(sessionsDir: string): PeerRecord[] {
	let entries: string[]
	try {
		entries = readdirSync(sessionsDir)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw error
	}
	const records: PeerRecord[] = []
	for (const entry of entries) {
		if (!entry.endsWith('.json')) continue
		let text: string
		try {
			text = readFileSync(join(sessionsDir, entry), 'utf8')
		} catch {
			continue // Vanished between readdir and read; not this reader's concern.
		}
		const record = parseRecordText(text)
		if (record) records.push(record)
	}
	return records
}

/** Remove a path only if it is owned by `uid`; `undefined` skips the check (tests, or a platform with no uid). */
function removeIfOwned(path: string, uid: number | undefined): void {
	let entry: ReturnType<typeof lstatSync>
	try {
		entry = lstatSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
		throw error
	}
	if (uid !== undefined && entry.uid !== uid) return
	try {
		unlinkSync(path)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
	}
}

/** Remove a session's registry record. Owner-checked: never unlinks a path this uid does not own. */
export function removePeerRecord(
	sessionsDir: string,
	sessionId: string,
	uid: number | undefined,
): void {
	removeIfOwned(recordPath(sessionsDir, sessionId), uid)
}

/** Remove a stale UDS socket file, only when it is a socket owned by `uid`. A `pipe:`/`a2a:` address is left alone. */
function removeStaleSocketIfOwned(address: string, uid: number | undefined): void {
	let parsed: ReturnType<typeof parsePeerAddress>
	try {
		parsed = parsePeerAddress(address)
	} catch {
		return
	}
	if (parsed.scheme !== 'uds') return
	let entry: ReturnType<typeof lstatSync>
	try {
		entry = lstatSync(parsed.path)
	} catch {
		return
	}
	if (!entry.isSocket()) return
	if (uid !== undefined && entry.uid !== uid) return
	try {
		unlinkSync(parsed.path)
	} catch {
		// Already gone, or another process just recreated it — either way there
		// is nothing left for this cleanup pass to do.
	}
}

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM means the process exists but is owned by someone else, which
		// cannot happen for a uid-owned registry entry under normal operation;
		// treated as alive because this check cannot disprove it either way.
		return (error as NodeJS.ErrnoException).code === 'EPERM'
	}
}

export interface PeerLivenessOptions {
	/** Default 500ms (design §1.2). */
	readonly pingTimeoutMs?: number
	/** Injectable for tests. Defaults to `process.kill(pid, 0)`. */
	readonly isPidAlive?: (pid: number) => boolean
	/** Injectable for tests. Defaults to an unauthenticated `ping` (`pingPeer` in `client.ts`). */
	readonly ping?: (address: string, timeoutMs: number) => Promise<boolean>
}

/**
 * A record is live iff its pid is alive AND its address answers a ping
 * within the timeout (design §1.2). Shared by {@link listLivePeers} and by
 * `createPeerEndpoint`'s default `verifySender` (`endpoint.ts`), so both
 * apply exactly the same definition of "live".
 */
export async function isPeerRecordLive(
	record: PeerRecord,
	options: PeerLivenessOptions = {},
): Promise<boolean> {
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive
	const ping = options.ping ?? pingPeer
	const timeoutMs = options.pingTimeoutMs ?? 500
	return isPidAlive(record.pid) && (await ping(record.address, timeoutMs))
}

export interface ListLivePeersOptions extends PeerLivenessOptions {
	readonly sessionsDir: string
	/** Owner-checks every removal; `undefined` skips the check (tests, or a platform with no uid). */
	readonly uid: number | undefined
}

/**
 * Every record in the registry that is live (see {@link isPeerRecordLive}).
 *
 * A record that is not live is DEAD: its registry file and, if it names a
 * UDS socket, the socket file are removed — but only when owned by this
 * uid, so one user's stale cleanup pass can never touch another's files
 * even if it could somehow see them.
 */
export async function listLivePeers(options: ListLivePeersOptions): Promise<PeerRecord[]> {
	const records = readPeerRecords(options.sessionsDir)
	const live: PeerRecord[] = []
	await Promise.all(
		records.map(async (record) => {
			const alive = await isPeerRecordLive(record, options)
			if (alive) {
				live.push(record)
				return
			}
			removePeerRecord(options.sessionsDir, record.sessionId, options.uid)
			removeStaleSocketIfOwned(record.address, options.uid)
		}),
	)
	return live
}
