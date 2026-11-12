// files.json (specification 3.2) and the archive (3.3), written byte for byte as the text says.
// The same folder gives the same bytes: entries in the order of files.json (files.json first), mode
// 0644, uid and gid 0, mtime 0, no user or group names, two zero blocks at the end, and gzip with
// fixed settings and a header that carries no time, no name and a fixed operating-system byte.
// This file shares NO code with archive-reader.mjs: the reader is the publisher's independent check.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { createGzip, constants as zlibConstants } from 'node:zlib'

const BLOCK = 512

const encode = (text) => Buffer.from(text, 'utf8')

/** Every regular file of a folder as `/`-separated relative paths; anything else is an error. */
export function listRegularFiles(root) {
	const found = []
	const visit = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name)
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name
			const stat = lstatSync(path)
			if (stat.isDirectory()) visit(path, relative)
			else if (stat.isFile()) found.push(relative)
			else throw new Error(`${relative} is not a regular file or a folder (a link or device cannot go in an archive).`)
		}
	}
	visit(root, '')
	return found
}

function hashFile(path) {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256')
		createReadStream(path)
			.on('data', (chunk) => hash.update(chunk))
			.on('error', reject)
			.on('end', () => resolve(hash.digest('hex')))
	})
}

/** The list of a kernel folder, ready to serialise: `{ schema: 1, files: [{ path, size, sha256 }] }`. */
export async function buildFilesList(root) {
	const paths = listRegularFiles(root)
	if (paths.includes('files.json'))
		throw new Error('The kernel folder already has a files.json; it is written by the pack step, not staged.')
	// Code unit order: the default string comparison, not a locale one.
	paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
	const files = []
	for (const path of paths)
		files.push({ path, size: lstatSync(join(root, path)).size, sha256: await hashFile(join(root, path)) })
	return { schema: 1, files }
}

/** The exact bytes of files.json: `JSON.stringify(value)` plus one newline. */
export const filesJsonBytes = (list) => encode(`${JSON.stringify(list)}\n`)

const octal = (value, width) => `${value.toString(8).padStart(width - 1, '0')}\0`

function header({ name, size, type }) {
	const block = Buffer.alloc(BLOCK)
	const nameBytes = encode(name)
	nameBytes.subarray(0, 100).copy(block, 0)
	block.write(octal(0o644, 8), 100, 'latin1')
	block.write(octal(0, 8), 108, 'latin1')
	block.write(octal(0, 8), 116, 'latin1')
	block.write(octal(size, 12), 124, 'latin1')
	block.write(octal(0, 12), 136, 'latin1')
	block.fill(0x20, 148, 156)
	block.write(type, 156, 'latin1')
	block.write('ustar\0', 257, 'latin1')
	block.write('00', 263, 'latin1')
	block.write(octal(0, 8), 329, 'latin1')
	block.write(octal(0, 8), 337, 'latin1')
	let sum = 0
	for (const byte of block) sum += byte
	block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
	return block
}

const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK)

/** A pax extended header carrying only `path`. */
function paxRecord(path) {
	const body = ` path=${path}\n`
	let length = Buffer.byteLength(body)
	// The length counts its own digits.
	while (Buffer.byteLength(`${length}${body}`) !== length) length = Buffer.byteLength(`${length}${body}`)
	return encode(`${length}${body}`)
}

/**
 * The chunks of the tar stream for a folder and its list. Names longer than 100 bytes get a pax
 * `x` entry in front of the file's own header.
 */
export async function* tarChunks(root, list) {
	const entries = [{ path: 'files.json', size: filesJsonBytes(list).length, bytes: filesJsonBytes(list) }, ...list.files]
	for (const entry of entries) {
		if (Buffer.byteLength(entry.path) > 100) {
			const record = paxRecord(entry.path)
			yield header({ name: 'PaxHeader', size: record.length, type: 'x' })
			yield record
			yield padding(record.length)
		}
		yield header({ name: entry.path, size: entry.size, type: '0' })
		if (entry.bytes) yield entry.bytes
		else {
			let seen = 0
			for await (const chunk of createReadStream(join(root, entry.path))) {
				seen += chunk.length
				yield chunk
			}
			if (seen !== entry.size) throw new Error(`${entry.path} changed size while it was being packed.`)
		}
		yield padding(entry.size)
	}
	yield Buffer.alloc(BLOCK * 2)
}

/** gzip writes its operating-system byte from the build machine; pin it so the bytes do not depend on it. */
function pinGzipHeader() {
	let first = true
	return new Transform({
		transform(chunk, _encoding, done) {
			if (first) {
				first = false
				const pinned = Buffer.from(chunk)
				pinned.fill(0, 4, 8) // mtime
				pinned[9] = 3 // Unix
				done(null, pinned)
				return
			}
			done(null, chunk)
		},
	})
}

/**
 * Write files.json and the archive for `root` into `outDir`-side paths. Returns the bundle entry
 * fields of the manifest (3.4) and the file names. Nothing is written into `root`.
 */
export async function writeArchive({ root, archivePath, filesJsonPath }) {
	const list = await buildFilesList(root)
	const filesBytes = filesJsonBytes(list)
	if (filesJsonPath) await pipeline(Readable.from([filesBytes]), createWriteStream(filesJsonPath))
	const sha512 = createHash('sha512')
	let size = 0
	const tap = new Transform({
		transform(chunk, _encoding, done) {
			sha512.update(chunk)
			size += chunk.length
			done(null, chunk)
		},
	})
	await pipeline(
		Readable.from(tarChunks(root, list)),
		createGzip({ level: 9, memLevel: 8, windowBits: 15, strategy: zlibConstants.Z_DEFAULT_STRATEGY }),
		pinGzipHeader(),
		tap,
		createWriteStream(archivePath),
	)
	return {
		list,
		bundle: {
			size,
			sha512: sha512.digest('hex'),
			filesSha512: createHash('sha512').update(filesBytes).digest('hex'),
			fileCount: list.files.length,
			unpackedSize: list.files.reduce((sum, file) => sum + file.size, 0),
		},
	}
}
