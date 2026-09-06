import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	realpathSync,
	writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Maximum bytes accepted from one curated file, before decoding or prompt clipping. */
export const MEMORY_FILE_MAX_BYTES = 1024 * 1024

export interface MemoryLocation {
	readonly path: string
	readonly root: string
}

function missing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function within(path: string, root: string): boolean {
	const part = relative(root, path)
	return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)
}

/** Resolve every existing segment before following the next, including symlink ancestors. */
export function resolveMemoryPath(location: MemoryLocation, createParents = false): string | null {
	const root = resolve(location.root)
	const path = resolve(location.path)
	if (!within(path, root)) throw new Error('Memory path is outside its allowed scope.')
	let rootStat: ReturnType<typeof lstatSync>
	try {
		rootStat = lstatSync(root)
	} catch (error) {
		if (!missing(error)) throw error
		if (!createParents) return null
		mkdirSync(root, { recursive: true, mode: 0o700 })
		rootStat = lstatSync(root)
	}
	if (rootStat.isSymbolicLink())
		throw new Error('Memory scope root is a symlink outside its allowed scope.')
	if (!rootStat.isDirectory()) throw new Error('Memory scope root must be a directory.')
	const canonicalRoot = realpathSync(root)
	const parts = relative(root, path).split(sep)
	let candidate = canonicalRoot
	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i]
		if (part === undefined) throw new Error('Memory path has an invalid segment.')
		candidate = join(candidate, part)
		const leaf = i === parts.length - 1
		let stat: ReturnType<typeof lstatSync>
		try {
			stat = lstatSync(candidate)
		} catch (error) {
			if (!missing(error)) throw error
			if (!createParents) return null
			if (leaf) return candidate
			mkdirSync(candidate, { mode: 0o700 })
			stat = lstatSync(candidate)
		}
		if (stat.isSymbolicLink()) {
			try {
				candidate = realpathSync(candidate)
			} catch (error) {
				if (missing(error)) throw new Error('Memory path contains a broken symlink.')
				throw error
			}
			if (!within(candidate, canonicalRoot))
				throw new Error('Memory path resolves outside its allowed scope.')
			stat = lstatSync(candidate)
		}
		if (leaf ? !stat.isFile() : !stat.isDirectory()) {
			throw new Error(
				leaf ? 'Memory must be a regular file.' : 'Memory path parent must be a directory.',
			)
		}
	}
	return candidate
}

function readBounded(fd: number): string {
	const stat = fstatSync(fd)
	if (!stat.isFile()) throw new Error('Memory must be a regular file.')
	if (stat.size > MEMORY_FILE_MAX_BYTES)
		throw new Error(`Memory exceeds the ${MEMORY_FILE_MAX_BYTES}-byte file limit.`)
	const chunks: Buffer[] = []
	let total = 0
	while (total <= MEMORY_FILE_MAX_BYTES) {
		const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MEMORY_FILE_MAX_BYTES + 1 - total))
		const count = readSync(fd, chunk, 0, chunk.length, total)
		if (count === 0) break
		total += count
		if (total > MEMORY_FILE_MAX_BYTES)
			throw new Error(`Memory exceeds the ${MEMORY_FILE_MAX_BYTES}-byte file limit.`)
		chunks.push(chunk.subarray(0, count))
	}
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))
	} catch {
		throw new Error('Memory is not valid UTF-8 text.')
	}
	if (text.includes('\0')) throw new Error('Memory contains NUL bytes; expected UTF-8 text.')
	return text
}

/** Open only the validated file; recheck path identity before reading or mutating it. */
function openMemory(location: MemoryLocation, append: boolean): number | null {
	const path = resolveMemoryPath(location, append)
	if (path === null) return null
	let existed = true
	let before: ReturnType<typeof lstatSync> | undefined
	try {
		before = lstatSync(path)
	} catch (error) {
		if (!append || !missing(error)) throw error
		existed = false
	}
	const flags =
		(append ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) |
		(constants.O_NOFOLLOW ?? 0) |
		(constants.O_NONBLOCK ?? 0) |
		(existed ? 0 : constants.O_CREAT | constants.O_EXCL)
	const fd = openSync(path, flags, 0o600)
	try {
		const opened = fstatSync(fd)
		const currentPath = resolveMemoryPath(location)
		if (
			currentPath !== path ||
			(before && (opened.dev !== before.dev || opened.ino !== before.ino))
		) {
			throw new Error('Memory path changed while opening it; no content was read or appended.')
		}
		const current = lstatSync(path)
		if (!opened.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
			throw new Error('Memory path changed or is not a regular file.')
		}
		return fd
	} catch (error) {
		closeSync(fd)
		throw error
	}
}

export function readMemoryFile(location: MemoryLocation): string | null {
	const fd = openMemory(location, false)
	if (fd === null) return null
	try {
		return readBounded(fd)
	} finally {
		closeSync(fd)
	}
}

/** Validate existing text before any append, refusing invalid files without replacing them. */
export function appendMemoryFile(location: MemoryLocation, text: string): string {
	if (Buffer.byteLength(text, 'utf8') > MEMORY_FILE_MAX_BYTES) {
		throw new Error(
			`Appending would exceed the ${MEMORY_FILE_MAX_BYTES}-byte memory file limit; curate the file first.`,
		)
	}
	const fd = openMemory(location, true)
	if (fd === null) throw new Error('Could not open memory for append.')
	try {
		const existing = readBounded(fd)
		const bytes = Buffer.from(text, 'utf8')
		if (fstatSync(fd).size + bytes.length > MEMORY_FILE_MAX_BYTES) {
			throw new Error(
				`Appending would exceed the ${MEMORY_FILE_MAX_BYTES}-byte memory file limit; curate the file first.`,
			)
		}
		let written = 0
		while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written)
		return `${existing}${text}`
	} finally {
		closeSync(fd)
	}
}
