import { createHash, randomBytes } from 'node:crypto'
import { type FileHandle, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'

/**
 * Content too large for one record, written beside the log before the record
 * that names it.
 *
 * A record is capped at `SESSION_RECORD_MAX_BYTES`. A body above the cap goes
 * to `<session-id>/tool-results/<name>.txt`, with a manifest at
 * `<name>.txt.manifest.json`, and the record carries a {@link SpillRef}: both
 * paths relative to the session directory, the body's byte length and its
 * SHA-256.
 *
 * ## Ordering
 *
 * The body is written to a private temporary name, fsynced, and published by
 * `link` (which refuses to replace an existing name); the manifest the same
 * way; then the directory is fsynced. Only after all of that does the caller
 * append the record. So a record never exists without its spill: a crash
 * before the append leaves an unreferenced spill, which costs space and
 * nothing else; a crash after it leaves a record whose spill is already on
 * stable storage.
 *
 * ## No clobbering
 *
 * A spill name is derived from a stable key (a tool call id, a message id),
 * so two writes can name the same file. `link` makes the first one win. A
 * second write with the same bytes adopts the existing file; one with
 * different bytes is refused, because replacing the file would silently
 * change what an earlier record's hash vouches for.
 *
 * The durable-write helpers below are copied from `utils/atomic-write.ts`
 * (the fsync-then-rename ordering, the directory fsync, the per-attempt
 * temporary name), so this module does not depend on a file the cutover
 * rewrites.
 */

/** The spill as a record names it. Paths are relative to the session directory. */
export interface SpillRef {
	readonly path: string
	readonly manifest: string
	readonly bytes: number
	readonly sha256: string
}

/** The manifest written beside a spilled body. */
export interface SpillManifest {
	readonly v: 1
	readonly kind: 'spill'
	/** What the body holds: a serialised message, a compaction summary, or plain text. */
	readonly content: 'message' | 'messages' | 'text'
	/** The key the name was derived from (a tool call id or a message id). */
	readonly key: string
	readonly bytes: number
	readonly sha256: string
	readonly createdAt: string
}

/** The directory, inside a session directory, that holds spills. */
export const SPILL_DIR = 'tool-results'

/** A spill that is missing, a different length, or a different hash than its record says. */
export class SpillIntegrityError extends Error {
	override readonly name = 'SpillIntegrityError'
	constructor(
		readonly path: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
	}
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}

/** The file name a key spills to: `<sha256(key)>.txt`, the same rule as `SessionPaths.toolResultFile`. */
export function spillFileName(key: string): string {
	if (key.length === 0) throw new Error('A spill key is required.')
	return `${sha256Hex(key)}.txt`
}

// ─── durable-write helpers (copied from utils/atomic-write.ts) ────────────

let counter = 0

/** A sidecar name private to one write: pid, a counter and random bytes. */
export function temporaryPathFor(filePath: string): string {
	counter = (counter + 1) % Number.MAX_SAFE_INTEGER
	return `${filePath}.${process.pid}.${counter}.${randomBytes(4).toString('hex')}.tmp`
}

/**
 * Make the entries of `directory` survive a power loss. Throws on POSIX when
 * the sync fails; does nothing on Windows, where a directory cannot be opened
 * for fsync and NTFS journals its metadata.
 */
export async function syncDirectory(directory: string): Promise<void> {
	if (process.platform === 'win32') return
	const handle = await open(directory, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 5

/** Rename, retrying briefly while Windows reports the target contended. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to)
			return
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code ?? ''
			if (!CONTENDED.has(code) || attempt >= RENAME_ATTEMPTS) throw err
			await new Promise((resolve) => setTimeout(resolve, attempt))
		}
	}
}

/**
 * Write `content` to a private temporary file and fsync it. The caller
 * publishes it (rename or link) and removes it on failure.
 */
export async function writeSyncedTemporary(target: string, content: string): Promise<string> {
	const temporary = temporaryPathFor(target)
	let handle: FileHandle | undefined
	try {
		handle = await open(temporary, 'wx', 0o600)
		await handle.writeFile(content, 'utf-8')
		await handle.sync()
		await handle.close()
		handle = undefined
		return temporary
	} catch (err) {
		await handle?.close().catch(() => undefined)
		await unlink(temporary).catch(() => undefined)
		throw err
	}
}

/**
 * Publish `content` at `target` atomically and durably, replacing whatever is
 * there: fsynced body, rename, fsynced directory.
 */
export async function durableReplaceFile(target: string, content: string): Promise<void> {
	const temporary = await writeSyncedTemporary(target, content)
	try {
		await renameWithRetry(temporary, target)
	} catch (err) {
		await unlink(temporary).catch(() => undefined)
		throw err
	}
	await syncDirectory(dirname(target))
}

/**
 * Publish `content` at `target` only if nothing is there. Returns `false`
 * when the name already exists (the caller decides whether that is a reuse
 * or a conflict); the file that is there is untouched.
 */
async function durableCreateFile(target: string, content: string): Promise<boolean> {
	const temporary = await writeSyncedTemporary(target, content)
	try {
		await link(temporary, target)
		return true
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw err
	} finally {
		await unlink(temporary).catch(() => undefined)
	}
}

// ─── spills ───────────────────────────────────────────────────────────────

/** Where spills are kept. The disk log uses files; the in-memory log a map. */
export interface SpillStore {
	write(key: string, content: SpillManifest['content'], text: string): Promise<SpillRef>
	read(ref: SpillRef): Promise<string>
}

function checkRelative(path: string): string {
	const normal = normalize(path)
	if (isAbsolute(normal) || normal.startsWith('..') || !normal.startsWith(`${SPILL_DIR}${sep}`)) {
		throw new SpillIntegrityError(path, `A spill path must stay inside ${SPILL_DIR}/: ${path}`)
	}
	return normal
}

function verify(ref: SpillRef, text: string): string {
	const bytes = Buffer.byteLength(text, 'utf8')
	if (bytes !== ref.bytes) {
		throw new SpillIntegrityError(
			ref.path,
			`Spill ${ref.path} is ${bytes} bytes; its record says ${ref.bytes}. Refusing rather than reading content the log cannot vouch for.`,
		)
	}
	if (sha256Hex(text) !== ref.sha256) {
		throw new SpillIntegrityError(
			ref.path,
			`Spill ${ref.path} does not match the SHA-256 its record carries. Refusing rather than reading content the log cannot vouch for.`,
		)
	}
	return text
}

/**
 * Spills on disk, under `<sessionDir>/tool-results/`.
 *
 * `write` resolves only once the body, the manifest and the directory entries
 * naming them are fsynced, which is what lets the caller append the record
 * next.
 */
export class DiskSpillStore implements SpillStore {
	constructor(
		readonly sessionDir: string,
		private readonly now: () => number = Date.now,
	) {}

	async write(key: string, content: SpillManifest['content'], text: string): Promise<SpillRef> {
		const dir = join(this.sessionDir, SPILL_DIR)
		await mkdir(dir, { recursive: true })
		const name = spillFileName(key)
		const ref: SpillRef = {
			path: `${SPILL_DIR}/${name}`,
			manifest: `${SPILL_DIR}/${name}.manifest.json`,
			bytes: Buffer.byteLength(text, 'utf8'),
			sha256: sha256Hex(text),
		}
		const body = join(dir, name)
		if (!(await durableCreateFile(body, text))) {
			// Adopt an identical earlier spill; refuse to replace a different one.
			const existing = await readFile(body, 'utf8')
			if (sha256Hex(existing) !== ref.sha256) {
				throw new SpillIntegrityError(
					ref.path,
					`Spill ${ref.path} already exists with different content. Refusing to replace it: an earlier record's hash vouches for the bytes that are there.`,
				)
			}
		}
		const manifest: SpillManifest = {
			v: 1,
			kind: 'spill',
			content,
			key,
			bytes: ref.bytes,
			sha256: ref.sha256,
			createdAt: new Date(this.now()).toISOString(),
		}
		// A manifest that already exists describes the same bytes (the body
		// check above established that), so it is kept as it is.
		await durableCreateFile(join(dir, `${name}.manifest.json`), `${JSON.stringify(manifest)}\n`)
		// The links that name both files, before any record points at them.
		await syncDirectory(dir)
		return ref
	}

	async read(ref: SpillRef): Promise<string> {
		const path = join(this.sessionDir, checkRelative(ref.path))
		let text: string
		try {
			text = await readFile(path, 'utf8')
		} catch (error) {
			throw new SpillIntegrityError(
				ref.path,
				`Spill ${ref.path} cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'}). Refusing rather than folding a message the log cannot vouch for.`,
				{ cause: error },
			)
		}
		return verify(ref, text)
	}
}

/** Spills held in process, for `InMemorySessionLog`. Same naming and checks as the disk store. */
export class InMemorySpillStore implements SpillStore {
	readonly #files = new Map<string, string>()

	async write(key: string, _content: SpillManifest['content'], text: string): Promise<SpillRef> {
		const name = spillFileName(key)
		const ref: SpillRef = {
			path: `${SPILL_DIR}/${name}`,
			manifest: `${SPILL_DIR}/${name}.manifest.json`,
			bytes: Buffer.byteLength(text, 'utf8'),
			sha256: sha256Hex(text),
		}
		const existing = this.#files.get(ref.path)
		if (existing !== undefined && sha256Hex(existing) !== ref.sha256) {
			throw new SpillIntegrityError(
				ref.path,
				`Spill ${ref.path} already exists with different content. Refusing to replace it: an earlier record's hash vouches for the bytes that are there.`,
			)
		}
		this.#files.set(ref.path, text)
		return ref
	}

	async read(ref: SpillRef): Promise<string> {
		const text = this.#files.get(checkRelative(ref.path).split(sep).join('/'))
		if (text === undefined) {
			throw new SpillIntegrityError(ref.path, `Spill ${ref.path} does not exist.`)
		}
		return verify(ref, text)
	}
}
