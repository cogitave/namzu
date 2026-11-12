import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import {
	FILES_LIST_NAME,
	type FilesList,
	FilesListError,
	type ListedFile,
	inFolder,
	parseFilesList,
	refuseName,
	sha512Hex,
} from './files-list.js'
import type { KernelFs } from './fs.js'

/**
 * Reads a kernel archive (section 3.3): gzip over a narrow tar. It is a reader, not a general
 * tar: everything the publisher does not write is refused, and the whole archive is refused on
 * the first thing wrong. It writes only below the folder it is given, creates every file new
 * (never through a link), and removes that folder again when it fails.
 */

export type ArchiveErrorCode =
	| 'gzip'
	| 'truncated'
	| 'header'
	| 'entry-type'
	| 'pax'
	| 'name'
	| 'collision'
	| 'files-list'
	| 'unlisted'
	| 'duplicate'
	| 'missing'
	| 'size'
	| 'hash'
	| 'too-many-files'
	| 'too-many-bytes'
	| 'trailing'

export class ArchiveError extends Error {
	constructor(
		readonly code: ArchiveErrorCode,
		message: string,
	) {
		super(message)
		this.name = 'ArchiveError'
	}
}

export interface ArchiveLimits {
	/** Most files the archive may hold (not counting files.json). */
	fileCount: number
	/** Most bytes the files may add up to. */
	unpackedSize: number
	/** The hash files.json must have (hex sha512 of its bytes). */
	filesSha512: string
}

export interface ExtractedArchive {
	list: FilesList
	filesBytes: Buffer
	unpackedBytes: number
}

const BLOCK = 512
const MAX_PAX_BYTES = 8192
const MAX_FILES_LIST_BYTES = 64 * 1024 * 1024
const COPY_CHUNK = 64 * 1024

class ByteReader {
	private chunks: Buffer[] = []
	private have = 0
	private finished = false
	private total = 0

	constructor(
		private readonly iterator: AsyncIterator<Buffer>,
		private readonly cap: number,
	) {}

	private async pull(): Promise<boolean> {
		if (this.finished) return false
		let result: IteratorResult<Buffer>
		try {
			result = await this.iterator.next()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			if (/unexpected end/iu.test(message))
				throw new ArchiveError('truncated', 'The archive ends early.')
			throw new ArchiveError('gzip', `The archive is not readable gzip (${message}).`)
		}
		if (result.done) {
			this.finished = true
			return false
		}
		const chunk = Buffer.isBuffer(result.value) ? result.value : Buffer.from(result.value)
		this.total += chunk.length
		if (this.total > this.cap)
			throw new ArchiveError('too-many-bytes', 'The archive unpacks to more than it states.')
		if (chunk.length > 0) {
			this.chunks.push(chunk)
			this.have += chunk.length
		}
		return true
	}

	private cut(count: number): Buffer {
		const out = Buffer.allocUnsafe(count)
		let written = 0
		while (written < count) {
			const head = this.chunks[0] as Buffer
			const take = Math.min(head.length, count - written)
			head.copy(out, written, 0, take)
			written += take
			if (take === head.length) this.chunks.shift()
			else this.chunks[0] = head.subarray(take)
		}
		this.have -= count
		return out
	}

	async take(count: number): Promise<Buffer> {
		while (this.have < count) {
			if (!(await this.pull())) throw new ArchiveError('truncated', 'The archive ends early.')
		}
		return this.cut(count)
	}

	async takeUpTo(max: number): Promise<Buffer> {
		while (this.have === 0) {
			if (!(await this.pull())) throw new ArchiveError('truncated', 'The archive ends early.')
		}
		return this.cut(Math.min(max, this.have))
	}

	/** True once the stream is over with nothing left, which also validates the gzip trailer. */
	async atEnd(): Promise<boolean> {
		while (this.have === 0) {
			if (!(await this.pull())) return true
		}
		return false
	}
}

function isZero(block: Buffer): boolean {
	for (const byte of block) if (byte !== 0) return false
	return true
}

function cString(block: Buffer, start: number, end: number): string {
	const slice = block.subarray(start, end)
	const stop = slice.indexOf(0)
	return slice.subarray(0, stop === -1 ? slice.length : stop).toString('utf8')
}

function octal(block: Buffer, start: number, end: number, what: string): number {
	const text = block
		.subarray(start, end)
		.toString('latin1')
		.replace(/^ +/u, '')
		.replace(/[\0 ]+$/u, '')
	if (!/^[0-7]{1,11}$/u.test(text))
		throw new ArchiveError('header', `The ${what} field of an entry is not a plain octal number.`)
	return Number.parseInt(text, 8)
}

interface Header {
	type: string
	name: string
	size: number
}

function readHeader(block: Buffer): Header {
	let sum = 0
	for (let index = 0; index < BLOCK; index++)
		sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number)
	if (octal(block, 148, 156, 'checksum') !== sum)
		throw new ArchiveError('header', 'An entry header has a bad checksum.')
	if (cString(block, 345, 500) !== '')
		throw new ArchiveError('header', 'An entry uses a path prefix; long names go in a pax header.')
	if (cString(block, 157, 257) !== '')
		throw new ArchiveError('entry-type', 'An entry names a link target.')
	return {
		type: String.fromCharCode(block[156] as number),
		name: cString(block, 0, 100),
		size: octal(block, 124, 136, 'size'),
	}
}

/** `<length> key=value\n` records; only `path` is allowed. */
function readPax(data: Buffer): string {
	let path: string | undefined
	let offset = 0
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset)
		if (space === -1) throw new ArchiveError('pax', 'A pax record has no length.')
		const lengthText = data.subarray(offset, space).toString('latin1')
		if (!/^[1-9]\d{0,5}$/u.test(lengthText))
			throw new ArchiveError('pax', 'A pax record has a bad length.')
		const length = Number(lengthText)
		if (offset + length > data.length || data[offset + length - 1] !== 0x0a)
			throw new ArchiveError('pax', 'A pax record has the wrong length.')
		const body = data.subarray(space + 1, offset + length - 1)
		const equals = body.indexOf(0x3d)
		if (equals === -1) throw new ArchiveError('pax', 'A pax record has no value.')
		const key = body.subarray(0, equals).toString('utf8')
		if (key !== 'path')
			throw new ArchiveError('pax', `A pax record sets ${key}, which is not allowed.`)
		if (path !== undefined) throw new ArchiveError('pax', 'A pax header sets the path twice.')
		path = body.subarray(equals + 1).toString('utf8')
		offset += length
	}
	if (path === undefined) throw new ArchiveError('pax', 'A pax header carries no path.')
	return path
}

function padding(size: number): number {
	return (BLOCK - (size % BLOCK)) % BLOCK
}

/**
 * Extracts into `target`, which must not exist yet (its parent must). Returns the file list it
 * read; the folder then holds files.json and every listed file, each checked by size and hash
 * as it was written.
 */
export async function extractArchive(options: {
	source: AsyncIterable<Uint8Array>
	target: string
	fs: KernelFs
	limits: ArchiveLimits
}): Promise<ExtractedArchive> {
	const { fs, target, limits } = options
	await fs.mkdir(target)
	const input = Readable.from(options.source, { objectMode: false })
	const gunzip = createGunzip({ chunkSize: COPY_CHUNK })
	input.on('error', (error) => gunzip.destroy(error))
	input.pipe(gunzip)
	const tarCap =
		limits.unpackedSize +
		(limits.fileCount + 2) * (BLOCK * 3 + MAX_PAX_BYTES) +
		MAX_FILES_LIST_BYTES
	const reader = new ByteReader(gunzip[Symbol.asyncIterator]() as AsyncIterator<Buffer>, tarCap)
	try {
		return await readEntries(reader, fs, target, limits)
	} catch (error) {
		await fs.rm(target).catch(() => undefined)
		throw error
	} finally {
		input.destroy()
		gunzip.destroy()
	}
}

async function readEntries(
	reader: ByteReader,
	fs: KernelFs,
	target: string,
	limits: ArchiveLimits,
): Promise<ExtractedArchive> {
	let list: FilesList | undefined
	let filesBytes: Buffer = Buffer.alloc(0)
	const listed = new Map<string, ListedFile>()
	const seen = new Set<string>()
	const madeFolders = new Set<string>()
	let unpackedBytes = 0
	let pendingPath: string | undefined

	for (;;) {
		const block = await reader.take(BLOCK)
		if (isZero(block)) {
			if (!isZero(await reader.take(BLOCK)))
				throw new ArchiveError('header', 'The end of the archive is one block, not two.')
			if (pendingPath !== undefined)
				throw new ArchiveError('pax', 'A pax header is not followed by a file.')
			break
		}
		const header = readHeader(block)
		if (header.type === 'x') {
			if (pendingPath !== undefined) throw new ArchiveError('pax', 'Two pax headers in a row.')
			if (header.size === 0 || header.size > MAX_PAX_BYTES)
				throw new ArchiveError('pax', 'A pax header is empty or too large.')
			const data = await reader.take(header.size)
			await reader.take(padding(header.size))
			pendingPath = readPax(data)
			continue
		}
		if (header.type !== '0')
			throw new ArchiveError(
				'entry-type',
				`An entry is type ${JSON.stringify(header.type)}, not a plain file.`,
			)
		const name = pendingPath ?? header.name
		pendingPath = undefined
		const refusal = refuseName(name)
		if (refusal) throw new ArchiveError('name', `The archive holds ${refusal}.`)

		if (list === undefined) {
			if (name !== FILES_LIST_NAME)
				throw new ArchiveError('files-list', 'The first entry is not files.json.')
			if (header.size > MAX_FILES_LIST_BYTES)
				throw new ArchiveError('files-list', 'files.json is too large.')
			filesBytes = await reader.take(header.size)
			await reader.take(padding(header.size))
			if (sha512Hex(filesBytes) !== limits.filesSha512)
				throw new ArchiveError('files-list', 'files.json is not the one the manifest names.')
			try {
				list = parseFilesList(filesBytes)
			} catch (error) {
				if (error instanceof FilesListError)
					throw new ArchiveError(
						error.code === 'collision'
							? 'collision'
							: error.code === 'name'
								? 'name'
								: 'files-list',
						error.message,
					)
				throw error
			}
			if (list.files.length > limits.fileCount)
				throw new ArchiveError(
					'too-many-files',
					'files.json lists more files than the manifest states.',
				)
			let sum = 0
			for (const file of list.files) {
				sum += file.size
				listed.set(file.path, file)
			}
			if (sum > limits.unpackedSize)
				throw new ArchiveError(
					'too-many-bytes',
					'The listed files add up to more than the manifest states.',
				)
			await fs.writeFile(inFolder(target, FILES_LIST_NAME), filesBytes)
			continue
		}

		if (name === FILES_LIST_NAME) throw new ArchiveError('duplicate', 'files.json appears twice.')
		const entry = listed.get(name)
		if (!entry)
			throw new ArchiveError(
				'unlisted',
				`The archive holds ${name}, which files.json does not list.`,
			)
		if (seen.has(name)) throw new ArchiveError('duplicate', `The archive holds ${name} twice.`)
		seen.add(name)
		if (header.size !== entry.size)
			throw new ArchiveError('size', `${name} has a different size than files.json says.`)
		unpackedBytes += header.size
		if (unpackedBytes > limits.unpackedSize)
			throw new ArchiveError('too-many-bytes', 'The files add up to more than the manifest states.')

		const path = inFolder(target, name)
		const slash = name.lastIndexOf('/')
		if (slash !== -1) {
			const folder = inFolder(target, name.slice(0, slash))
			if (!madeFolders.has(folder)) {
				await fs.mkdir(folder, { recursive: true })
				madeFolders.add(folder)
			}
		}
		const sink = await fs.openWrite(path)
		const hash = createHash('sha256')
		let remaining = header.size
		try {
			while (remaining > 0) {
				const chunk = await reader.takeUpTo(Math.min(remaining, COPY_CHUNK))
				hash.update(chunk)
				await sink.write(chunk)
				remaining -= chunk.length
			}
		} finally {
			await sink.close()
		}
		await reader.take(padding(header.size))
		if (hash.digest('hex') !== entry.sha256)
			throw new ArchiveError('hash', `${name} does not match its hash in files.json.`)
	}

	if (!list) throw new ArchiveError('files-list', 'The archive holds no files.json.')
	if (!(await reader.atEnd()))
		throw new ArchiveError('trailing', 'The archive has bytes after its end blocks.')
	for (const file of list.files)
		if (!seen.has(file.path))
			throw new ArchiveError('missing', `${file.path} is listed but not in the archive.`)
	return { list, filesBytes, unpackedBytes }
}
