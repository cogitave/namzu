import { createReadStream } from 'node:fs'
import { type FileHandle, mkdir, open, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SessionLocator, SessionPaths } from '../../session/paths.js'
import type { SessionId } from '../../types/ids/index.js'
import type { SessionLogEntry } from './chain.js'
import {
	type LogMedium,
	type ReadSessionLogOptions,
	SessionLogConflictError,
	SessionLogCore,
	type SessionLogCoreOptions,
	type SessionLogRead,
	type SessionLogReadSummary,
	collect,
	walkSessionLog,
} from './core.js'
import { DiskSessionLeaseStore } from './lease.js'
import { DiskSpillStore, syncDirectory } from './spill.js'

/**
 * The session log on disk: `<session-id>.jsonl` beside `<session-id>/`.
 *
 * ## Appends
 *
 * Each record is one `write` to a file opened `O_APPEND`, so a line is never
 * interleaved with another writer's bytes. Before the write the file must be
 * exactly as long as the writer last verified it; after it, the bytes must be
 * where the writer put them. Either check failing is a
 * `SessionLogConflictError`: another writer got in, which the lease exists to
 * prevent and the fence check makes rare (a holder stalled past its expiry
 * in the microseconds between its fence check and its write).
 *
 * Records others depend on — the turn lifecycle, checkpoints, decisions —
 * are fsynced by default (`sync: 'boundaries'`). Other records are not: a
 * process crash keeps the page cache, and a power loss that drops them leaves
 * a torn or short tail, which the next writer repairs or which a checkpoint's
 * anchor refuses. `sync: 'all'` fsyncs every record.
 */

function isErrno(error: unknown, code: string): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === code
}

/** The bytes of one log file. */
export class DiskLogMedium implements LogMedium {
	constructor(readonly file: string) {}

	async size(): Promise<number> {
		try {
			return (await stat(this.file)).size
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return 0
			throw error
		}
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		let handle: FileHandle
		try {
			handle = await open(this.file, 'r')
		} catch (error) {
			if (isErrno(error, 'ENOENT')) return new Uint8Array(0)
			throw error
		}
		try {
			const buffer = Buffer.alloc(length)
			const { bytesRead } = await handle.read(buffer, 0, length, offset)
			return buffer.subarray(0, bytesRead)
		} finally {
			await handle.close()
		}
	}

	async *stream(offset: number): AsyncIterable<Uint8Array> {
		if ((await this.size()) <= offset) return
		const stream = createReadStream(this.file, { start: offset, highWaterMark: 1 << 20 })
		try {
			for await (const chunk of stream) yield chunk as Buffer
		} catch (error) {
			if (!isErrno(error, 'ENOENT')) throw error
		}
	}

	async append(bytes: Uint8Array, expectedOffset: number, sync: boolean): Promise<void> {
		await mkdir(dirname(this.file), { recursive: true })
		const handle = await open(this.file, 'a', 0o600)
		try {
			const before = (await handle.stat()).size
			if (before !== expectedOffset) {
				throw new SessionLogConflictError(
					`${this.file} is ${before} bytes; this writer verified it at ${expectedOffset}. Another writer appended; refusing to write a record that would not chain.`,
				)
			}
			await handle.write(bytes)
			if (sync) await handle.datasync()
			const after = (await handle.stat()).size
			if (after !== expectedOffset + bytes.byteLength) {
				const landed = Buffer.alloc(bytes.byteLength)
				await handle.read(landed, 0, bytes.byteLength, expectedOffset)
				if (!landed.equals(bytes)) {
					throw new SessionLogConflictError(
						`${this.file} was appended to by another writer at the same moment; this record did not land at byte ${expectedOffset}.`,
					)
				}
			}
		} finally {
			await handle.close()
		}
		// The directory entry of a newly created log, before anything depends on it.
		if (expectedOffset === 0 && sync) await syncDirectory(dirname(this.file))
	}

	async truncate(size: number, expectedSize: number): Promise<void> {
		const handle = await open(this.file, 'r+')
		try {
			const current = (await handle.stat()).size
			if (current !== expectedSize) {
				throw new SessionLogConflictError(
					`${this.file} is ${current} bytes, not the ${expectedSize} measured before repairing its tail; refusing to cut a log that is still changing.`,
				)
			}
			await handle.truncate(size)
			await handle.datasync()
		} finally {
			await handle.close()
		}
	}
}

export interface DiskSessionLogOptions
	extends Pick<SessionLogCoreOptions, 'now' | 'spillAboveBytes' | 'sync'> {
	readonly sessionId: SessionId
	/** `<session-id>.jsonl`. */
	readonly file: string
	/** `<session-id>/`: the lease files and `tool-results/`. */
	readonly sessionDir: string
}

/** A session log on disk. One instance per writer process; readers may open their own. */
export class DiskSessionLog extends SessionLogCore {
	readonly file: string
	readonly sessionDir: string

	constructor(options: DiskSessionLogOptions) {
		super({
			sessionId: options.sessionId,
			medium: new DiskLogMedium(options.file),
			leases: new DiskSessionLeaseStore(options.sessionDir),
			spills: new DiskSpillStore(options.sessionDir, options.now),
			now: options.now,
			spillAboveBytes: options.spillAboveBytes,
			sync: options.sync,
		})
		this.file = options.file
		this.sessionDir = options.sessionDir
	}

	/** The log of `locator` in a project's layout. */
	static at(
		paths: SessionPaths,
		locator: SessionLocator,
		options: Pick<SessionLogCoreOptions, 'now' | 'spillAboveBytes' | 'sync'> = {},
	): DiskSessionLog {
		return new DiskSessionLog({
			...options,
			sessionId: locator.sessionId,
			file: paths.sessionLog(locator),
			sessionDir: paths.sessionDir(locator),
		})
	}
}

/**
 * Walk a session log file, verifying the chain (spec §4.1). Yields each
 * record with its pointer and returns the summary. A missing file is an empty
 * log.
 */
export function streamSessionLog(
	file: string,
	options: ReadSessionLogOptions & { readonly sessionId?: SessionId } = {},
): AsyncGenerator<SessionLogEntry, SessionLogReadSummary> {
	return walkSessionLog(new DiskLogMedium(file), options)
}

/** Read a whole session log file: strict by default, or tolerant (stops at the first break). */
export function readSessionLog(
	file: string,
	options: ReadSessionLogOptions & { readonly sessionId?: SessionId } = {},
): Promise<SessionLogRead> {
	return collect(streamSessionLog(file, options))
}
