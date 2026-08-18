import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { NamzuError } from '../../types/errors/index.js'
import { temporaryPathFor } from '../../utils/atomic-write.js'
import { type SchemaDefinition, stamp } from '../schema.js'
import { DiskRecordStore } from './record-store.js'

/** The compatibility projection and the immutable commit directory for one record. */
export interface RevisionedRecordLocation {
	readonly legacyPath: string
	readonly revisionsDir: string
	/**
	 * False when the previous projection naming scheme is not injective for
	 * this key. The immutable commit remains authoritative and enumerable;
	 * publishing a colliding compatibility file would damage another record.
	 */
	readonly publishLegacyProjection?: boolean
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
 * Recover an opaque id from its canonical revision-directory segment.
 *
 * Listing stores need the inverse: a committed first write can exist without
 * its best-effort legacy projection, so enumerating projection files alone
 * would make a successful commit invisible. Non-canonical names return null
 * rather than aliasing a real id; re-encoding is the final canonicality check.
 */
export function decodeRevisionFileSegment(segment: string): string | null {
	if (segment === '~empty') return ''
	if (segment.length === 0) return null

	let value = ''
	for (let i = 0; i < segment.length; i++) {
		const char = segment[i]
		if (char === undefined) return null
		if (char !== '~') {
			if (!/[0-9A-Za-z_-]/u.test(char)) return null
			value += char
			continue
		}

		const escaped = segment.slice(i + 1, i + 5)
		if (!/^[0-9a-f]{4}$/u.test(escaped)) return null
		value += String.fromCharCode(Number.parseInt(escaped, 16))
		i += 4
	}

	return revisionFileSegment(value) === segment ? value : null
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
export class DiskRevisionRecordStore<T> {
	private readonly records: DiskRecordStore<T>

	constructor(
		private readonly schema: SchemaDefinition,
		private readonly label: string,
		private readonly revisionOf: (record: T) => number,
	) {
		this.records = new DiskRecordStore<T>(schema)
	}

	private checkedRevision(record: T, context: string): number {
		const revision = this.revisionOf(record)
		assertRevision(revision, context)
		return revision
	}

	async read(location: RevisionedRecordLocation): Promise<T | null> {
		return await this.readStable(location, 1)
	}

	private async readStable(location: RevisionedRecordLocation, attempt: number): Promise<T | null> {
		const { headRevision, headName } = await this.findHead(location)

		const legacy = await this.records.read(location.legacyPath)
		const legacyRevision =
			legacy === null ? undefined : this.checkedRevision(legacy, `${this.label} legacy projection`)
		if (headName === undefined) return legacy

		const head = await this.records.read(join(location.revisionsDir, headName))
		if (head === null) {
			// Revision commits are immutable and never removed. ENOENT after the
			// listing therefore means another, incompatible actor changed the store.
			throw this.incompatible(location, 'the immutable head disappeared after it was listed', {
				headRevision,
			})
		}
		const bodyRevision = this.checkedRevision(head, `${this.label} immutable head`)
		if (bodyRevision !== headRevision) {
			throw this.incompatible(location, 'the revision filename and record body disagree', {
				headRevision,
				bodyRevision,
			})
		}

		if (legacy !== null && legacyRevision !== undefined && legacyRevision > bodyRevision) {
			// A current writer commits the next immutable entry before updating
			// the projection. If it completed between our first directory listing
			// and projection read, the pair looks exactly like a legacy writer ahead
			// until we list the head again. Distinguish that read race from durable
			// disagreement before refusing the record.
			const refreshed = await this.findHead(location)
			if (refreshed.headRevision > bodyRevision) {
				if (attempt < READ_SNAPSHOT_ATTEMPTS) {
					return await this.readStable(location, attempt + 1)
				}
				throw new NamzuError({
					code: 'storage_error',
					message: `${this.label}: the record kept advancing while its revision snapshot was read; retry after the writers settle.`,
					details: {
						path: location.legacyPath,
						headRevision: bodyRevision,
						refreshedRevision: refreshed.headRevision,
						attempts: attempt,
					},
					retryable: true,
				})
			}
			throw this.incompatible(
				location,
				'the legacy projection is ahead of the immutable commit head',
				{ headRevision: bodyRevision, legacyRevision },
			)
		}
		if (legacy !== null && legacyRevision === bodyRevision && !isDeepStrictEqual(legacy, head)) {
			throw this.incompatible(
				location,
				'the legacy projection and immutable head contain different values at one revision',
				{ headRevision: bodyRevision, legacyRevision },
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
		const currentRevision =
			current === null ? 0 : this.checkedRevision(current, `${this.label} current record`)
		const expectedNext = currentRevision + 1
		const proposedRevision = this.checkedRevision(proposal.record, `${this.label} proposed record`)
		if (proposedRevision !== expectedNext) {
			throw new NamzuError({
				code: 'storage_error',
				message: `${this.label}: mutation proposed revision ${proposedRevision}, but the next committed revision is ${expectedNext}.`,
				details: {
					path: location.revisionsDir,
					currentRevision,
					proposedRevision,
				},
				retryable: false,
			})
		}

		await mkdir(location.revisionsDir, { recursive: true })
		const target = join(location.revisionsDir, `${proposedRevision}.json`)
		try {
			await this.publish(target, proposal.record)
		} catch (err) {
			if (!isErrno(err, 'EEXIST')) throw err

			// A contender committed this exact next revision. Re-evaluate the
			// domain guard against its complete value so the public store reports
			// its own Stale*/Exists error with the durable actual revision.
			const winner = await this.read(location)
			mutate(winner)
			const winnerRevision =
				winner === null ? 0 : this.checkedRevision(winner, `${this.label} winning record`)
			throw this.incompatible(
				location,
				'a revision destination already existed but the domain mutation still accepted its winner',
				{ revision: winnerRevision },
			)
		}

		// The immutable entry above is the commit. This projection lets an old
		// reader see the latest value after a stopped upgrade, but it cannot be
		// allowed to turn a committed success into an ambiguous failure. A later
		// current reader accepts a projection behind the head; the next successful
		// mutation refreshes it. Equal-but-different and ahead are refused in read().
		if (location.publishLegacyProjection !== false) {
			await (async () => {
				await mkdir(dirname(location.legacyPath), { recursive: true })
				await this.records.write(location.legacyPath, proposal.record)
			})().catch(() => undefined)
		}
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
