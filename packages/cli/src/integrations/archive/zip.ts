import { inflateRawSync } from 'node:zlib'

/**
 * Just enough of ZIP to read an archive someone else made, with the safety checks applied to the central
 * directory BEFORE any entry is inflated: an archive that fails one writes nothing anywhere. The caller
 * passes its own limits and a word for what the archive is ("package", "skill"), and wraps
 * {@link ArchiveError} in its own error type.
 */

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

export interface ArchiveLimits {
	readonly maxEntries: number
	readonly maxUnpackedBytes: number
	/** Largest accepted uncompressed to compressed size ratio of one entry. */
	readonly maxRatio: number
	/** When false, an entry with an execute bit is refused (`zip-executable`). */
	readonly allowExecutable: boolean
	/** What the archive is called in messages. Default `archive`. */
	readonly subject?: string
}

export interface ArchiveEntry {
	readonly name: string
	readonly method: number
	readonly compressedSize: number
	readonly size: number
	readonly localOffset: number
	readonly mode: number
}

export interface ArchiveFile {
	readonly bytes: Buffer
	/** The zip entry carried an execute bit (POSIX). */
	readonly executable: boolean
}

/** A refusal with a stable `check` name and a plain message. Neutral: callers map it to their own error. */
export class ArchiveError extends Error {
	override readonly name = 'ArchiveError'
	constructor(
		readonly check: string,
		message: string,
	) {
		super(message)
	}
}

const bad = (check: string, message: string): ArchiveError => new ArchiveError(check, message)
const subjectOf = (l: ArchiveLimits): string => l.subject ?? 'archive'
const mebibytes = (bytes: number): string => `${bytes / (1024 * 1024)} MiB`

export function listEntries(archive: Buffer, limits: ArchiveLimits): ArchiveEntry[] {
	const subject = subjectOf(limits)
	if (archive.length < 22) throw bad('zip', `This is not a valid ${subject} file (too short).`)
	let eocd = -1
	for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 0xffff); at--) {
		if (archive.readUInt32LE(at) === EOCD) {
			eocd = at
			break
		}
	}
	if (eocd < 0) throw bad('zip', `This is not a valid ${subject} file (no zip directory).`)
	if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0)
		throw bad('zip', 'Multi-disk archives are not accepted.')
	const count = archive.readUInt16LE(eocd + 10)
	const dirSize = archive.readUInt32LE(eocd + 12)
	const dirOffset = archive.readUInt32LE(eocd + 16)
	if (count === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff)
		throw bad('zip', 'Zip64 archives are not accepted.')
	if (count > limits.maxEntries)
		throw bad(
			'zip-entries',
			`The ${subject} has ${count} entries; at most ${limits.maxEntries} are accepted.`,
		)
	if (dirOffset + dirSize > archive.length) throw bad('zip', 'The zip directory is truncated.')
	const out: ArchiveEntry[] = []
	let at = dirOffset
	for (let i = 0; i < count; i++) {
		if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL)
			throw bad('zip', `Directory entry ${i} is malformed.`)
		const madeBy = archive.readUInt16LE(at + 4)
		const flags = archive.readUInt16LE(at + 8)
		const method = archive.readUInt16LE(at + 10)
		const compressedSize = archive.readUInt32LE(at + 20)
		const size = archive.readUInt32LE(at + 24)
		const nameLength = archive.readUInt16LE(at + 28)
		const extraLength = archive.readUInt16LE(at + 30)
		const commentLength = archive.readUInt16LE(at + 32)
		const external = archive.readUInt32LE(at + 38)
		const localOffset = archive.readUInt32LE(at + 42)
		const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
		at += 46 + nameLength + extraLength + commentLength
		if (flags & 1) throw bad('zip-encrypted', `${name} is encrypted.`)
		if (compressedSize === 0xffffffff || size === 0xffffffff)
			throw bad('zip', `${name} is a zip64 entry.`)
		// Only an archive made on a Unix system carries a file mode in the high half of the attributes.
		const mode = madeBy >> 8 === 3 ? external >>> 16 : 0
		out.push({ name, method, compressedSize, size, localOffset, mode })
	}
	return out
}

/** The zip-safety rules, applied to names and sizes only. */
export function checkEntries(entries: readonly ArchiveEntry[], limits: ArchiveLimits): void {
	const subject = subjectOf(limits)
	const seen = new Set<string>()
	const seenFold = new Set<string>()
	let total = 0
	for (const e of entries) {
		const n = e.name
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
		if (/[\u0000-\u001f\u007f]/.test(n))
			throw bad('zip-name', `An entry name has a control character: ${JSON.stringify(n)}.`)
		if (n.startsWith('/') || n.startsWith('\\') || /^[A-Za-z]:/.test(n))
			throw bad('zip-name', `An entry has an absolute path: ${n}.`)
		if (n.includes('\\')) throw bad('zip-name', `An entry name has a backslash: ${n}.`)
		if (n.split('/').some((p) => p === '..'))
			throw bad('zip-slip', `An entry climbs out of the ${subject} folder: ${n}.`)
		if (seen.has(n)) throw bad('zip-duplicate', `The ${subject} names ${n} twice.`)
		seen.add(n)
		const fold = n.toLowerCase()
		if (seenFold.has(fold))
			throw bad(
				'zip-case',
				`Two entries differ only by letter case (${n}); Windows would merge them.`,
			)
		seenFold.add(fold)
		const type = e.mode & 0o170000
		if (type !== 0 && type !== 0o100000 && type !== 0o040000)
			throw bad('zip-link', `${n} is a link or a device, not a file.`)
		if (!limits.allowExecutable && (e.mode & 0o111) !== 0)
			throw bad('zip-executable', `${n} is marked executable, which is not accepted.`)
		if (e.method !== 0 && e.method !== 8)
			throw bad('zip', `${n} uses compression method ${e.method}, which is not accepted.`)
		if (e.size > 0 && e.compressedSize > 0 && e.size / e.compressedSize > limits.maxRatio)
			throw bad('zip-bomb', `${n} expands more than ${limits.maxRatio} to 1.`)
		if (e.size > 0 && e.compressedSize === 0) throw bad('zip-bomb', `${n} has an impossible size.`)
		total += e.size
		if (total > limits.maxUnpackedBytes)
			throw bad(
				'zip-size',
				`The ${subject} unpacks to more than ${mebibytes(limits.maxUnpackedBytes)}.`,
			)
	}
}

export function readEntry(archive: Buffer, e: ArchiveEntry): Buffer {
	const at = e.localOffset
	if (at + 30 > archive.length || archive.readUInt32LE(at) !== LOCAL)
		throw bad('zip', `The header of ${e.name} is malformed.`)
	const start = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28)
	const end = start + e.compressedSize
	if (end > archive.length) throw bad('zip', `${e.name} is truncated.`)
	const data = archive.subarray(start, end)
	let out: Buffer
	try {
		out = e.method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: e.size + 1 })
	} catch {
		throw bad('zip-bomb', `${e.name} does not inflate to its declared size.`)
	}
	if (out.length !== e.size)
		throw bad('zip', `${e.name} inflated to ${out.length} bytes; the directory says ${e.size}.`)
	return out
}

/** Every file of an archive, in memory, after the zip-safety checks. Directory entries are dropped. */
export function openArchive(archive: Buffer, limits: ArchiveLimits): Map<string, ArchiveFile> {
	const entries = listEntries(archive, limits)
	checkEntries(entries, limits)
	const files = new Map<string, ArchiveFile>()
	for (const e of entries) {
		if (e.name.endsWith('/')) continue
		files.set(e.name, { bytes: readEntry(archive, e), executable: (e.mode & 0o111) !== 0 })
	}
	return files
}
