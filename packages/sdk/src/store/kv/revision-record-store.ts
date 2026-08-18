import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { NamzuError } from '../../types/errors/index.js'
import { temporaryPathFor } from '../../utils/atomic-write.js'
import { type SchemaDefinition, stamp } from '../schema.js'
import { DiskRecordStore } from './record-store.js'

/** A record whose integer revision is its compare-and-set boundary. */
interface RevisionedRecord {
	readonly revision: number
}

/** The compatibility projection and the immutable commit directory for one record. */
export interface RevisionedRecordLocation {
	readonly legacyPath: string
	readonly revisionsDir: string
}

/** One proposed committed value and the caller value it produces. */
export interface RevisionMutation<T, R> {
	readonly record: T
	readonly result: R
}

/** Only strict positive safe-integer revision names are commits. */
const REVISION_NAME = /^([1-9][0-9]{0,15})\.json$/

/** A hot record may advance while a reader obtains its directory snapshot. */
const READ_SNAPSHOT_ATTEMPTS = 8

/** Filesystems on which a complete exclusive hard-link publication cannot be made. */
const NO_LINK = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

function isErrno(err: unknown, code: string): boolean {
	return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function assertRevision(value: number, context: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new NamzuError({
			code: 'storage_error',
			message: `${context}: revision must be a positive safe integer, got ${value}.`,
			details: { revision: value },
			retryable: false,
		})
	}
}

/**
 * Turn an opaque public id into exactly one injective filesystem segment.
 *
 * The unescaped alphabet deliberately excludes `.`, `%`, `~` and every path
 * separator. Each other UTF-16 code unit has one fixed-width spelling, so
 * `../x`, a literal escape-looking id, and an unpaired surrogate cannot
 * collide or leave the store root.
 */
export function revisionFileSegment(value: string): string {
	if (value.length === 0) return '~empty'

	let out = ''
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		const safe =
			(code >= 48 && code <= 57) ||
			(code >= 65 && code <= 90) ||
			(code >= 97 && code <= 122) ||
			code === 45 ||
			code === 95
		out += safe ? value[i] : `~${code.toString(16).padStart(4, '0')}`
	}
	return out
}

/**
 * Preserve the old single-file name whenever it was already one path
 * component. The immutable log always uses {@link revisionFileSegment}, but
 * changing a dotted, spaced or Unicode id's projection name would strand the
 * record written by the previous store implementation during upgrade.
 */
export function legacyRevisionFileSegment(value: string): string {
	return /[\\/\0]/u.test(value) ? revisionFileSegment(value) : value
}

/**
 * Immutable revision commits over a filesystem.
 *
 * The body is complete before `link` publishes its revision name. `link`
 * supplies the one kernel decision a read-check-replace sequence lacks:
 * exactly one process can create `N.json`. Revision names are never deleted;
 * deleting one would let an arbitrarily delayed stale writer issue N again.
 *
 * The old single-file record remains a compatibility projection. It is not
 * authoritative once immutable commits exist, but it is checked on every
 * read. A different value at the same revision, or a legacy revision ahead
 * of the commit head, is evidence of an incompatible writer and is refused.
 */
export class DiskRevisionRecordStore<T extends RevisionedRecord> {
	private readonly records: DiskRecordStore<T>

	constructor(
		private readonly schema: SchemaDefinition,
		private readonly label: string,
	) {
		this.records = new DiskRecordStore<T>(schema)
	}

	async read(location: RevisionedRecordLocation): Promise<T | null> {
		return await this.readStable(location, 1)
	}

	private async readStable(location: RevisionedRecordLocation, attempt: number): Promise<T | null> {
		const { headRevision, headName } = await this.findHead(location)

		const legacy = await this.records.read(location.legacyPath)
		if (legacy !== null) assertRevision(legacy.revision, `${this.label} legacy projection`)
		if (headName === undefined) return legacy

		const head = await this.records.read(join(location.revisionsDir, headName))
		if (head === null) {
			// Revision commits are immutable and never removed. ENOENT after the
			// listing therefore means another, incompatible actor changed the store.
			throw this.incompatible(location, 'the immutable head disappeared after it was listed', {
				headRevision,
			})
		}
		assertRevision(head.revision, `${this.label} immutable head`)
		if (head.revision !== headRevision) {
			throw this.incompatible(location, 'the revision filename and record body disagree', {
				headRevision,
				bodyRevision: head.revision,
			})
		}

		if (legacy !== null && legacy.revision > head.revision) {
			// A current writer commits the next immutable entry before updating
			// the projection. If it completed between our first directory listing
			// and projection read, the pair looks exactly like a legacy writer ahead
			// until we list the head again. Distinguish that read race from durable
			// disagreement before refusing the record.
			const refreshed = await this.findHead(location)
			if (refreshed.headRevision > head.revision) {
				if (attempt < READ_SNAPSHOT_ATTEMPTS) {
					return await this.readStable(location, attempt + 1)
				}
				throw new NamzuError({
					code: 'storage_error',
					message: `${this.label}: the record kept advancing while its revision snapshot was read; retry after the writers settle.`,
					details: {
						path: location.legacyPath,
						headRevision: head.revision,
						refreshedRevision: refreshed.headRevision,
						attempts: attempt,
					},
					retryable: true,
				})
			}
			throw this.incompatible(
				location,
				'the legacy projection is ahead of the immutable commit head',
				{ headRevision: head.revision, legacyRevision: legacy.revision },
			)
		}
		if (legacy !== null && legacy.revision === head.revision && !isDeepStrictEqual(legacy, head)) {
			throw this.incompatible(
				location,
				'the legacy projection and immutable head contain different values at one revision',
				{ headRevision: head.revision, legacyRevision: legacy.revision },
			)
		}

		return head
	}

	private async findHead(
		location: RevisionedRecordLocation,
	): Promise<{ headRevision: number; headName: string | undefined }> {
		const names = await this.records.scanNames(location.revisionsDir, '')
		let headRevision = 0
		let headName: string | undefined

		for (const name of names) {
			const match = REVISION_NAME.exec(name)
			if (!match) continue
			const revision = Number(match[1])
			if (!Number.isSafeInteger(revision) || revision <= headRevision) continue
			headRevision = revision
			headName = name
		}
		return { headRevision, headName }
	}

	async transact<R>(
		location: RevisionedRecordLocation,
		mutate: (current: T | null) => RevisionMutation<T, R>,
	): Promise<R> {
		const current = await this.read(location)
		const proposal = mutate(current)
		const expectedNext = (current?.revision ?? 0) + 1
		assertRevision(proposal.record.revision, `${this.label} proposed record`)
		if (proposal.record.revision !== expectedNext) {
			throw new NamzuError({
				code: 'storage_error',
				message: `${this.label}: mutation proposed revision ${proposal.record.revision}, but the next committed revision is ${expectedNext}.`,
				details: {
					path: location.revisionsDir,
					currentRevision: current?.revision ?? 0,
					proposedRevision: proposal.record.revision,
				},
				retryable: false,
			})
		}

		await mkdir(location.revisionsDir, { recursive: true })
		const target = join(location.revisionsDir, `${proposal.record.revision}.json`)
		try {
			await this.publish(target, proposal.record)
		} catch (err) {
			if (!isErrno(err, 'EEXIST')) throw err

			// A contender committed this exact next revision. Re-evaluate the
			// domain guard against its complete value so the public store reports
			// its own Stale*/Exists error with the durable actual revision.
			const winner = await this.read(location)
			mutate(winner)
			throw this.incompatible(
				location,
				'a revision destination already existed but the domain mutation still accepted its winner',
				{ revision: winner?.revision ?? 0 },
			)
		}

		// The immutable entry above is the commit. This projection lets an old
		// reader see the latest value after a stopped upgrade, but it cannot be
		// allowed to turn a committed success into an ambiguous failure. A later
		// current reader accepts a projection behind the head; the next successful
		// mutation refreshes it. Equal-but-different and ahead are refused in read().
		await (async () => {
			await mkdir(dirname(location.legacyPath), { recursive: true })
			await this.records.write(location.legacyPath, proposal.record)
		})().catch(() => undefined)
		return proposal.result
	}

	private async publish(target: string, record: T): Promise<void> {
		const temporary = temporaryPathFor(target)
		try {
			try {
				await writeFile(temporary, `${JSON.stringify(stamp(this.schema, record), null, 2)}\n`, {
					encoding: 'utf-8',
					flag: 'wx',
				})
			} catch (err) {
				if (isErrno(err, 'EEXIST')) {
					throw new NamzuError({
						code: 'storage_error',
						message: `${this.label}: temporary publication path already exists; refusing a scratch collision.`,
						details: { path: temporary },
						retryable: false,
						cause: err,
					})
				}
				throw err
			}

			try {
				await link(temporary, target)
			} catch (err) {
				if (isErrno(err, 'EEXIST')) throw err
				const code = (err as NodeJS.ErrnoException).code
				if (code !== undefined && NO_LINK.has(code)) {
					throw new NamzuError({
						code: 'capability_unavailable',
						message: `${this.label}: this filesystem cannot publish an exclusive complete revision (${code}). Put the store on a filesystem with hard-link support or use a single in-memory owner; refusing rather than degrading to read-check-replace.`,
						details: { path: dirname(target), code },
						retryable: false,
						cause: err,
					})
				}
				throw err
			}
		} finally {
			await unlink(temporary).catch(() => undefined)
		}
	}

	private incompatible(
		location: RevisionedRecordLocation,
		reason: string,
		details: Record<string, unknown>,
	): NamzuError {
		return new NamzuError({
			code: 'storage_error',
			message: `${this.label}: incompatible writers or damaged revision data: ${reason}. Stop every process using another SDK version, then repair or restore this record before retrying.`,
			details: { path: location.legacyPath, ...details },
			retryable: false,
		})
	}
}
