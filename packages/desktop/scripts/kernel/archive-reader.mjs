// The READER of a kernel archive (specification 3.3), written on its own: it shares no code with
// archive-writer.mjs, so the publisher's last check before upload also proves the writer follows
// the text. It reads a .tar.gz as a stream, never holds the archive in memory, and refuses the whole
// archive on the first thing the text forbids. A refusal is an `ArchiveRefusal` with a plain message.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'

export class ArchiveRefusal extends Error {
	constructor(message) {
		super(message)
		this.name = 'ArchiveRefusal'
	}
}

const refuse = (message) => {
	throw new ArchiveRefusal(message)
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`)

/**
 * Is this a name an archive may carry? Returns a reason when it is not, undefined when it is.
 * Absolute path, drive letter or `:`, backslash, empty or `.`/`..` segment, a Windows device
 * name (with or without an extension), a segment ending in a dot or a space.
 */
export function refusalForName(name) {
	if (typeof name !== 'string' || name === '') return 'an empty name'
	if (name.startsWith('/')) return 'an absolute path'
	if (name.includes('\\')) return 'a backslash'
	if (name.includes(':')) return 'a ":" (a drive letter or a stream name)'
	for (const char of name) if (char.charCodeAt(0) < 0x20) return 'a control character'
	for (const segment of name.split('/')) {
		if (segment === '') return 'an empty segment'
		if (segment === '.' || segment === '..') return `the segment "${segment}"`
		if (/[. ]$/.test(segment)) return `the segment "${segment}", which ends in a dot or a space`
		if (RESERVED.test(segment.split('.')[0])) return `the segment "${segment}", a reserved device name on Windows`
	}
	return undefined
}

/** A pull reader over an async iterable of Buffers. */
class Bytes {
	constructor(source) {
		this.iterator = source[Symbol.asyncIterator]()
		this.pending = Buffer.alloc(0)
		this.ended = false
	}
	async fill(wanted) {
		while (this.pending.length < wanted && !this.ended) {
			const { value, done } = await this.iterator.next()
			if (done) this.ended = true
			else this.pending = this.pending.length === 0 ? value : Buffer.concat([this.pending, value])
		}
	}
	/** Up to `count` bytes; fewer only at the end of the stream. */
	async take(count) {
		await this.fill(count)
		const out = this.pending.subarray(0, count)
		this.pending = this.pending.subarray(count)
		return out
	}
	/** Whether any byte is left. */
	async hasMore() {
		await this.fill(1)
		return this.pending.length > 0
	}
}

function parseOctal(field, what) {
	const text = field.toString('latin1').replace(/\0.*$/s, '').trim()
	if (!/^[0-7]+$/.test(text)) return refuse(`The archive has a header with a bad ${what} field.`)
	return Number.parseInt(text, 8)
}

function checksumOk(block) {
	let sum = 0
	for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]
	return sum === parseOctal(block.subarray(148, 156), 'checksum')
}

function paxPath(data) {
	let path
	let at = 0
	while (at < data.length) {
		const space = data.indexOf(0x20, at)
		const length = Number.parseInt(data.subarray(at, space).toString('latin1'), 10)
		if (space < 0 || !Number.isSafeInteger(length) || length < 1 || at + length > data.length)
			return refuse('The archive has a malformed pax record.')
		const record = data.subarray(space + 1, at + length)
		if (record[record.length - 1] !== 0x0a) return refuse('The archive has a malformed pax record.')
		const text = record.subarray(0, -1).toString('utf8')
		const equals = text.indexOf('=')
		const key = text.slice(0, equals)
		if (equals < 0 || key !== 'path') return refuse(`The archive has a pax key "${key}"; only "path" is allowed.`)
		path = text.slice(equals + 1)
		at += length
	}
	if (path === undefined) return refuse('The archive has a pax header without a path.')
	return path
}

function parseFilesJson(bytes) {
	let value
	try {
		value = JSON.parse(bytes.toString('utf8'))
	} catch {
		return refuse('files.json is not valid JSON.')
	}
	const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)
	if (!isObject(value) || Object.keys(value).join() !== 'schema,files' || value.schema !== 1 || !Array.isArray(value.files))
		return refuse('files.json does not have the shape { "schema": 1, "files": [...] }.')
	let previous
	const seen = new Set()
	for (const file of value.files) {
		if (!isObject(file) || Object.keys(file).join() !== 'path,size,sha256')
			return refuse('files.json has an entry that is not { path, size, sha256 }.')
		const reason = refusalForName(file.path)
		if (reason) return refuse(`files.json lists "${file.path}": ${reason}.`)
		if (file.path === 'files.json') return refuse('files.json lists itself.')
		if (!Number.isSafeInteger(file.size) || file.size < 0) return refuse(`files.json gives "${file.path}" a bad size.`)
		if (typeof file.sha256 !== 'string' || !HEX(64).test(file.sha256)) return refuse(`files.json gives "${file.path}" a bad sha256.`)
		if (previous !== undefined && !(previous < file.path)) return refuse('files.json is not sorted by code unit order, or lists a path twice.')
		const folded = file.path.toLowerCase()
		if (seen.has(folded)) return refuse(`files.json lists two names that are equal in lower case ("${file.path}").`)
		seen.add(folded)
		previous = file.path
	}
	if (`${JSON.stringify(value)}\n` !== bytes.toString('utf8'))
		return refuse('files.json is not serialised as JSON.stringify(value) and one newline.')
	return value
}

/**
 * Read an archive. `limits` is `{ fileCount, unpackedSize }` from the manifest (files.json and its own
 * bytes are not counted: they are the list, not the kernel). `sink`, when given, receives the files:
 * `{ begin(path), write(chunk), end(path) }`, called in archive order, after the name was accepted.
 * Resolves to `{ filesJson (the bytes), list, files: Map(path -> { size, sha256 }) }`; rejects with
 * ArchiveRefusal on anything the text forbids.
 */
export async function readArchive(path, { limits, sink } = {}) {
	const gunzip = createGunzip()
	const input = createReadStream(path)
	input.on('error', (error) => gunzip.destroy(error))
	input.pipe(gunzip)
	const bytes = new Bytes(gunzip)
	try {
		return await readEntries(bytes, limits, sink)
	} catch (error) {
		if (error instanceof ArchiveRefusal) throw error
		throw new ArchiveRefusal(`The archive cannot be read as gzip over tar: ${error.message}`)
	} finally {
		input.destroy()
		gunzip.destroy()
	}
}

async function readEntries(bytes, limits, sink) {
	let filesJson
	let list
	let listed
	const read = new Map()
	const folded = new Set()
	let count = 0
	let total = 0
	let firstEntry = true
	let nextPath

	for (;;) {
		const block = await bytes.take(512)
		if (block.length < 512) return refuse('The archive ends in the middle of a header (truncated).')
		if (block.every((byte) => byte === 0)) {
			const second = await bytes.take(512)
			if (second.length < 512 || !second.every((byte) => byte === 0)) return refuse('The archive does not end with two zero blocks.')
			if (await bytes.hasMore()) return refuse('The archive has bytes after its end blocks.')
			break
		}
		if (!checksumOk(block)) return refuse('The archive has a header whose checksum is wrong.')
		if (block.subarray(257, 263).toString('latin1') !== 'ustar\0') return refuse('The archive has a header that is not ustar.')
		const type = String.fromCharCode(block[156])
		if (type !== '0' && type !== 'x') return refuse(`The archive has an entry of type "${type}"; only regular files are allowed.`)
		if (block[345] !== 0) return refuse('The archive has an entry with a name prefix.')
		const size = parseOctal(block.subarray(124, 136), 'size')
		const nameEnd = block.indexOf(0, 0)
		const name = block.subarray(0, nameEnd < 0 || nameEnd > 100 ? 100 : nameEnd).toString('utf8')
		const padding = (512 - (size % 512)) % 512

		if (type === 'x') {
			if (nextPath !== undefined) return refuse('The archive has two pax headers in a row.')
			if (size > 65536) return refuse('The archive has an oversized pax header.')
			const data = await bytes.take(size)
			if (data.length < size) return refuse('The archive is truncated inside a pax header.')
			await bytes.take(padding)
			nextPath = paxPath(data)
			continue
		}

		const entryPath = nextPath ?? name
		nextPath = undefined
		const reason = refusalForName(entryPath)
		if (reason) return refuse(`The archive has an entry named "${entryPath}": ${reason}.`)
		const lower = entryPath.toLowerCase()
		if (folded.has(lower)) return refuse(`The archive has two names that are equal in lower case ("${entryPath}").`)
		folded.add(lower)

		if (firstEntry) {
			firstEntry = false
			if (entryPath !== 'files.json') return refuse('The first entry of the archive is not files.json.')
			if (size > 64 * 1024 * 1024) return refuse('files.json is too large.')
			filesJson = await bytes.take(size)
			if (filesJson.length < size) return refuse('The archive is truncated inside files.json.')
			await bytes.take(padding)
			list = parseFilesJson(filesJson)
			listed = new Map(list.files.map((file) => [file.path, file]))
			if (limits && list.files.length > limits.fileCount) return refuse(`files.json lists ${list.files.length} files; the manifest allows ${limits.fileCount}.`)
			continue
		}

		const expected = listed.get(entryPath)
		if (!expected) return refuse(`The archive has the file "${entryPath}", which files.json does not list.`)
		if (size !== expected.size) return refuse(`"${entryPath}" is ${size} bytes in the archive and ${expected.size} in files.json.`)
		count += 1
		total += size
		if (limits && count > limits.fileCount) return refuse(`The archive has more than the ${limits.fileCount} files the manifest states.`)
		if (limits && total > limits.unpackedSize) return refuse(`The archive unpacks to more than the ${limits.unpackedSize} bytes the manifest states.`)
		const hash = createHash('sha256')
		await sink?.begin(entryPath)
		let remaining = size
		while (remaining > 0) {
			const chunk = await bytes.take(Math.min(remaining, 1 << 20))
			if (chunk.length === 0) return refuse(`The archive is truncated inside "${entryPath}".`)
			hash.update(chunk)
			await sink?.write(chunk)
			remaining -= chunk.length
		}
		await sink?.end(entryPath)
		const digest = hash.digest('hex')
		if (digest !== expected.sha256) return refuse(`"${entryPath}" does not match its sha256 in files.json.`)
		await bytes.take(padding)
		read.set(entryPath, { size, sha256: digest })
	}

	if (!list) return refuse('The archive has no files.json.')
	if (nextPath !== undefined) return refuse('The archive ends after a pax header with no file.')
	for (const file of list.files) if (!read.has(file.path)) return refuse(`files.json lists "${file.path}" and the archive does not have it.`)
	return { filesJson, list, files: read }
}
