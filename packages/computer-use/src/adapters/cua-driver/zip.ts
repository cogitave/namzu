import { inflateRawSync } from 'node:zlib'

/**
 * Just enough of the ZIP format to take one file out of an archive whose
 * SHA-256 has already been checked: the central directory, stored and
 * deflated entries. ZIP64, encryption and multi-disk archives are refused,
 * not guessed at — the pinned release archives use none of them.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN_LENGTH = 22
const MAX_COMMENT_LENGTH = 0xffff
const ZIP64_MARKER = 0xffffffff

export class ZipFormatError extends Error {
	override readonly name = 'ZipFormatError'
}

/** The bytes of the entry named `name` (exact, `/`-separated), or undefined when the archive has none. */
export function extractZipEntry(archive: Buffer, name: string): Buffer | undefined {
	const eocd = findEndOfCentralDirectory(archive)
	const entries = archive.readUInt16LE(eocd + 10)
	const size = archive.readUInt32LE(eocd + 12)
	const offset = archive.readUInt32LE(eocd + 16)
	if (size === ZIP64_MARKER || offset === ZIP64_MARKER || entries === 0xffff) {
		throw new ZipFormatError('ZIP64 archives are not supported.')
	}
	if (offset + size > archive.length)
		throw new ZipFormatError('The central directory is truncated.')

	let at = offset
	for (let index = 0; index < entries; index++) {
		if (at + 46 > archive.length || archive.readUInt32LE(at) !== CENTRAL_SIGNATURE) {
			throw new ZipFormatError(`Central directory entry ${index} is malformed.`)
		}
		const flags = archive.readUInt16LE(at + 8)
		const method = archive.readUInt16LE(at + 10)
		const compressedSize = archive.readUInt32LE(at + 20)
		const uncompressedSize = archive.readUInt32LE(at + 24)
		const nameLength = archive.readUInt16LE(at + 28)
		const extraLength = archive.readUInt16LE(at + 30)
		const commentLength = archive.readUInt16LE(at + 32)
		const localOffset = archive.readUInt32LE(at + 42)
		const entryName = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8')
		at += 46 + nameLength + extraLength + commentLength
		if (entryName !== name) continue

		if ((flags & 0x1) !== 0) throw new ZipFormatError(`${name} is encrypted.`)
		if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER) {
			throw new ZipFormatError(`${name} is a ZIP64 entry, which is not supported.`)
		}
		if (
			localOffset + 30 > archive.length ||
			archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
		) {
			throw new ZipFormatError(`The local header of ${name} is malformed.`)
		}
		const dataStart =
			localOffset +
			30 +
			archive.readUInt16LE(localOffset + 26) +
			archive.readUInt16LE(localOffset + 28)
		const dataEnd = dataStart + compressedSize
		if (dataEnd > archive.length) throw new ZipFormatError(`${name} is truncated.`)
		const data = archive.subarray(dataStart, dataEnd)
		let content: Buffer
		if (method === 0) content = Buffer.from(data)
		else if (method === 8) content = inflateRawSync(data)
		else
			throw new ZipFormatError(`${name} uses compression method ${method}, which is not supported.`)
		if (content.length !== uncompressedSize) {
			throw new ZipFormatError(
				`${name} inflated to ${content.length} bytes; the directory says ${uncompressedSize}.`,
			)
		}
		return content
	}
	return undefined
}

function findEndOfCentralDirectory(archive: Buffer): number {
	if (archive.length < EOCD_MIN_LENGTH) throw new ZipFormatError('Not a ZIP archive: too short.')
	const lowest = Math.max(0, archive.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH)
	for (let at = archive.length - EOCD_MIN_LENGTH; at >= lowest; at--) {
		if (archive.readUInt32LE(at) === EOCD_SIGNATURE) return at
	}
	throw new ZipFormatError('Not a ZIP archive: no end-of-central-directory record.')
}
