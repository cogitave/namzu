import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

/**
 * Reader for Electron asar archives.
 *
 * Layout: a Chromium Pickle header (`u32 4`, `u32 headerPickleSize`,
 * `u32 payloadSize`, `u32 jsonLength`), then `jsonLength` bytes of JSON,
 * padded to 4, then the file data. The JSON is a tree of
 * `{ files: { name: entry } }`; a file entry is
 * `{ size, offset: "<decimal>", executable?, unpacked?, integrity?, link? }`,
 * where `offset` is relative to the end of the header. A file marked
 * `unpacked` is not in the archive; it lives under `<archive>.unpacked/`.
 *
 * The archive is hostile input. Names become path components or are refused,
 * every offset and size is checked against the file, and every write goes
 * through `O_EXCL` into a directory this function created or found empty.
 */

export interface ExtractAsarOptions {
	/** Stop after this many files (default 200 000). */
	maxFiles?: number
	/** Stop writing past this many bytes in total (default 2 GiB). */
	maxTotalBytes?: number
	/** Largest header JSON accepted (default 64 MiB). */
	maxHeaderBytes?: number
	/** Expected SHA-256 of the header JSON (Electron's `ElectronAsarIntegrity`), hex. */
	expectedHeaderSha256?: string
	/**
	 * What to do with a file whose integrity hash does not match: `skip` (default)
	 * leaves it out and reports it, `write` writes it and reports it.
	 */
	onIntegrityMismatch?: 'skip' | 'write'
}

export type AsarEntryStatus =
	| 'written'
	| 'skipped'
	| 'integrity-mismatch'
	| 'integrity-mismatch-written'

export interface AsarEntryReport {
	/** Path inside the archive, `/`-separated. */
	path: string
	size: number
	status: AsarEntryStatus
	/** True when the bytes came from the `.asar.unpacked` directory. */
	unpacked: boolean
	/** True when the entry carried integrity data and it matched. */
	verified: boolean
	/** Why it was skipped or flagged. */
	reason?: string
}

export interface AsarResult {
	outDir: string
	headerSha256: string
	/** Null when no `expectedHeaderSha256` was given. */
	headerMatches: boolean | null
	files: number
	written: number
	writtenBytes: number
	skipped: number
	integrityMismatches: number
	entries: AsarEntryReport[]
}

export class AsarError extends Error {
	override readonly name = 'AsarError'
	constructor(
		readonly code:
			| 'bad_header'
			| 'header_too_large'
			| 'header_mismatch'
			| 'too_many_files'
			| 'out_dir_invalid'
			| 'io_error',
		message: string,
	) {
		super(message)
	}
}

interface AsarNode {
	files?: Record<string, AsarNode>
	size?: number
	offset?: string
	unpacked?: boolean
	executable?: boolean
	link?: string
	integrity?: {
		algorithm?: string
		hash?: string
		blockSize?: number
		blocks?: string[]
	}
}

const WINDOWS_DEVICES = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
	...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/** Why `name` cannot be one path component, or null when it can. */
export function unsafeComponent(name: string): string | null {
	if (name === '' || name === '.' || name === '..') return `reserved name ${JSON.stringify(name)}`
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i)
		if (c < 0x20 || name[i] === '/' || name[i] === '\\' || name[i] === ':') {
			return 'contains a separator, colon or control character'
		}
	}
	if (name.length > 255) return 'longer than 255 characters'
	if (/[. ]$/.test(name)) return 'ends with a dot or space'
	if (WINDOWS_DEVICES.has(name.split('.')[0]?.toLowerCase() ?? '')) return 'reserved device name'
	return null
}

async function prepareOutDir(outDir: string): Promise<string> {
	const dir = resolve(outDir)
	let info: Awaited<ReturnType<typeof lstat>> | null = null
	try {
		info = await lstat(dir)
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw new AsarError('io_error', `outDir ${dir}: ${(err as Error).message}`)
		}
	}
	if (info) {
		if (!info.isDirectory()) {
			throw new AsarError('out_dir_invalid', `outDir ${dir} exists and is not a directory`)
		}
		if ((await readdir(dir)).length > 0) {
			throw new AsarError('out_dir_invalid', `outDir ${dir} is not empty`)
		}
	} else {
		await mkdir(dir, { recursive: true })
	}
	return realpath(dir)
}

/** Read exactly `length` bytes at `position`, or throw. */
async function readExact(
	fh: Awaited<ReturnType<typeof open>>,
	position: number,
	length: number,
): Promise<Buffer> {
	const buf = Buffer.alloc(length)
	let done = 0
	while (done < length) {
		const { bytesRead } = await fh.read(buf, done, length - done, position + done)
		if (bytesRead === 0) throw new AsarError('bad_header', 'the archive ends before its data does')
		done += bytesRead
	}
	return buf
}

function sha256Hex(data: Buffer): string {
	return createHash('sha256').update(data).digest('hex')
}

function checkIntegrity(node: AsarNode, data: Buffer): 'none' | 'ok' | string {
	const info = node.integrity
	if (!info?.hash) return 'none'
	if ((info.algorithm ?? 'SHA256').toUpperCase() !== 'SHA256') return 'none'
	if (sha256Hex(data) !== info.hash.toLowerCase())
		return 'the file hash does not match its integrity record'
	if (info.blockSize && info.blocks && info.blockSize > 0) {
		const expected = Math.ceil(data.length / info.blockSize)
		if (info.blocks.length !== expected) return 'the block hash count does not match the file size'
		for (let i = 0; i < expected; i++) {
			const block = data.subarray(i * info.blockSize, (i + 1) * info.blockSize)
			if (sha256Hex(block) !== (info.blocks[i] ?? '').toLowerCase()) {
				return `block ${i} does not match its integrity record`
			}
		}
	}
	return 'ok'
}

/**
 * Extract `archive` into `outDir`. The directory must not exist or must be
 * empty. Symbolic links inside the archive are reported as skipped and never
 * created. Returns a report of every file; it throws `AsarError` only when the
 * archive as a whole cannot be trusted (bad header, hash of the header wrong,
 * too many files, unusable output directory).
 */
export async function extractAsar(
	archive: string,
	outDir: string,
	options: ExtractAsarOptions = {},
): Promise<AsarResult> {
	const maxFiles = options.maxFiles ?? 200_000
	const maxTotal = options.maxTotalBytes ?? 2 * 1024 ** 3
	const maxHeader = options.maxHeaderBytes ?? 64 << 20
	const archivePath = resolve(archive)

	const fh = await open(archivePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
		async () => open(archivePath, 'r'),
	)
	try {
		const stat = await fh.stat()
		if (!stat.isFile()) throw new AsarError('bad_header', `${archivePath} is not a regular file`)
		if (stat.size < 16)
			throw new AsarError('bad_header', 'the file is too short to be an asar archive')
		const head = await readExact(fh, 0, 16)
		if (head.readUInt32LE(0) !== 4) {
			throw new AsarError('bad_header', 'the first word is not 4; this is not an asar archive')
		}
		const pickleSize = head.readUInt32LE(4)
		const jsonLength = head.readUInt32LE(12)
		if (jsonLength > maxHeader) {
			throw new AsarError(
				'header_too_large',
				`the header is ${jsonLength} bytes, over the ${maxHeader} byte limit`,
			)
		}
		// The payload size field counts the 4-byte length word and the padded JSON.
		const padded = Math.ceil(jsonLength / 4) * 4
		if (head.readUInt32LE(8) !== pickleSize - 4 || pickleSize !== 4 + 4 + padded) {
			throw new AsarError('bad_header', 'the header pickle sizes are inconsistent')
		}
		const dataStart = 8 + pickleSize
		if (dataStart > stat.size)
			throw new AsarError('bad_header', 'the header runs past the end of the file')
		const jsonBytes = await readExact(fh, 16, jsonLength)
		const headerSha256 = sha256Hex(jsonBytes)
		const expected = options.expectedHeaderSha256?.toLowerCase()
		if (expected && expected !== headerSha256) {
			throw new AsarError(
				'header_mismatch',
				`the header hash ${headerSha256} does not match the expected ${expected}`,
			)
		}
		let root: AsarNode
		try {
			root = JSON.parse(jsonBytes.toString('utf8')) as AsarNode
		} catch {
			throw new AsarError('bad_header', 'the header is not valid JSON')
		}
		if (
			!root ||
			typeof root !== 'object' ||
			typeof root.files !== 'object' ||
			root.files === null
		) {
			throw new AsarError('bad_header', 'the header has no file tree')
		}

		const base = await prepareOutDir(outDir)
		const unpackedRoot = `${archivePath}.unpacked`
		const entries: AsarEntryReport[] = []
		const report = (e: AsarEntryReport) => entries.push(e)
		let written = 0
		let writtenBytes = 0
		let mismatches = 0
		let fileCount = 0
		const seen = new Set<string>()
		const mismatchPolicy = options.onIntegrityMismatch ?? 'skip'

		const walk = async (node: AsarNode, parts: string[], depth: number): Promise<void> => {
			if (depth > 64)
				throw new AsarError('bad_header', 'the file tree is nested more than 64 levels')
			for (const [name, child] of Object.entries(node.files ?? {})) {
				const path = [...parts, name]
				const shown = path.join('/')
				const bad = unsafeComponent(name)
				if (child === null || typeof child !== 'object') {
					report({
						path: shown,
						size: 0,
						status: 'skipped',
						unpacked: false,
						verified: false,
						reason: 'malformed entry',
					})
					continue
				}
				if (bad) {
					fileCount++
					report({
						path: shown,
						size: 0,
						status: 'skipped',
						unpacked: false,
						verified: false,
						reason: `unsafe name: ${bad}`,
					})
					continue
				}
				if (child.files) {
					await walk(child, path, depth + 1)
					continue
				}
				fileCount++
				if (fileCount > maxFiles) {
					throw new AsarError('too_many_files', `the archive has more than ${maxFiles} files`)
				}
				const unpacked = child.unpacked === true
				const skip = (reason: string) =>
					report({
						path: shown,
						size: Number(child.size) || 0,
						status: 'skipped',
						unpacked,
						verified: false,
						reason,
					})
				if (typeof child.link === 'string') {
					skip('symbolic link (not created)')
					continue
				}
				const size = child.size
				if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
					skip('invalid size')
					continue
				}
				const key = path.join('/').toLowerCase()
				if (seen.has(key)) {
					skip('collides with another entry of the same path')
					continue
				}
				seen.add(key)
				if (writtenBytes + size > maxTotal) {
					skip(`writing it would pass the ${maxTotal} byte total limit`)
					continue
				}
				let data: Buffer
				if (unpacked) {
					const src = join(unpackedRoot, ...path)
					try {
						const info = await lstat(src)
						if (!info.isFile()) {
							skip('the unpacked entry is not a regular file')
							continue
						}
						if (info.size !== size) {
							skip(`the unpacked file is ${info.size} bytes, the header says ${size}`)
							continue
						}
						const rf = await open(src, 'r')
						try {
							data = await readExact(rf, 0, size)
						} finally {
							await rf.close()
						}
					} catch (err) {
						skip(
							`the unpacked file could not be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
						)
						continue
					}
				} else {
					const offset = Number(child.offset)
					if (
						typeof child.offset !== 'string' ||
						!/^\d+$/.test(child.offset) ||
						!Number.isSafeInteger(offset)
					) {
						skip('invalid offset')
						continue
					}
					if (dataStart + offset + size > stat.size) {
						skip('its data lies outside the archive')
						continue
					}
					data = await readExact(fh, dataStart + offset, size)
				}
				const verdict = checkIntegrity(child, data)
				const mismatch = verdict !== 'none' && verdict !== 'ok'
				if (mismatch) {
					mismatches++
					if (mismatchPolicy === 'skip') {
						report({
							path: shown,
							size,
							status: 'integrity-mismatch',
							unpacked,
							verified: false,
							reason: verdict,
						})
						continue
					}
				}
				const target = resolve(base, ...path)
				if (!target.startsWith(base + sep)) {
					skip('path escapes the output directory')
					continue
				}
				try {
					let dir = base
					for (const part of path.slice(0, -1)) {
						dir = join(dir, part)
						await mkdir(dir).catch((err: NodeJS.ErrnoException) => {
							if (err.code !== 'EEXIST') throw err
						})
						if (!(await lstat(dir)).isDirectory())
							throw new Error('a parent of this path is a file')
					}
					// 'wx' is O_EXCL: never follows a link, never overwrites.
					const out = await open(target, 'wx', child.executable ? 0o755 : 0o644)
					try {
						await out.writeFile(data)
					} finally {
						await out.close()
					}
				} catch (err) {
					skip(`could not be written: ${(err as Error).message}`)
					continue
				}
				written++
				writtenBytes += size
				report({
					path: shown,
					size,
					status: mismatch ? 'integrity-mismatch-written' : 'written',
					unpacked,
					verified: verdict === 'ok',
					...(mismatch ? { reason: verdict } : {}),
				})
			}
		}
		await walk(root, [], 0)

		return {
			outDir: base,
			headerSha256,
			headerMatches: expected ? true : null,
			files: fileCount,
			written,
			writtenBytes,
			skipped: entries.filter((e) => e.status === 'skipped').length,
			integrityMismatches: mismatches,
			entries,
		}
	} finally {
		await fh.close()
	}
}
