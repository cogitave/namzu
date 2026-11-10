/**
 * Whether a memory that names files still describes them.
 *
 * A memory such as "the tools live in `src/tools/`" goes stale without
 * anyone noticing: the file moves, and the memory keeps saying where it was.
 * When the curator stores a memory that names files of the project, it
 * records an anchor for each (at most five): the path relative to the
 * project, the size and modification time the file had, and a SHA-256 of its
 * bytes. Nothing of a file's content is kept, only that digest.
 *
 * When recall is about to show a memory, the anchors are checked: a file that
 * is gone, or whose size and time changed and whose digest no longer matches,
 * makes the memory say it may be out of date. The memory is still shown; the
 * model decides what to trust. Matching size and time pass without reading
 * the file, so the usual check is one `stat` per anchor.
 *
 * Bounds: at most `ANCHOR_MAX` anchors per memory and no file larger than
 * `ANCHOR_HASH_MAX_BYTES` is read; a larger file is anchored by size and time
 * alone. A path that resolves outside the project (by `..`, an absolute path
 * or a symbolic link) is never anchored and never checked.
 *
 * Pure of the terminal: the project root and the file system are handed in.
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

/** The most files one memory is anchored to. */
export const ANCHOR_MAX = 5
/** The largest file whose bytes are read to make or check a digest. */
export const ANCHOR_HASH_MAX_BYTES = 1_048_576
/** The metadata key the anchors are kept under. */
export const ANCHORS_KEY = 'anchors'

export interface MemoryAnchor {
	/** Relative to the project root, with `/` separators. */
	readonly path: string
	readonly size: number
	readonly mtimeMs: number
	/** Absent when the file was too large to read. */
	readonly sha256?: string
}

export interface AnchorFs {
	/** Size and modification time of a regular file; undefined for anything else. Rejects with the system code when absent. */
	stat(path: string): Promise<{ readonly size: number; readonly mtimeMs: number } | undefined>
	realpath(path: string): Promise<string>
	readFile(path: string): Promise<Uint8Array>
}

export const nodeAnchorFs: AnchorFs = {
	stat: async (path) => {
		const info = await stat(path)
		return info.isFile() ? { size: info.size, mtimeMs: Math.trunc(info.mtimeMs) } : undefined
	},
	realpath: (path) => realpath(path),
	readFile: (path) => readFile(path),
}

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** `path` inside `root` as a relative `/` path, or undefined when it is not inside. */
function inside(root: string, path: string): string | undefined {
	const rel = relative(root, path)
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined
	return rel.split(sep).join('/')
}

/** The file at `rel` under `root`, resolved through links and still inside it. */
async function locate(
	root: string,
	rel: string,
	fs: AnchorFs,
): Promise<{ readonly real: string; readonly rel: string } | undefined> {
	const lexical = inside(root, resolve(root, rel))
	if (lexical === undefined) return undefined
	const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(resolve(root, rel))])
	return inside(realRoot, real) === undefined ? undefined : { real, rel: lexical }
}

// A name with a directory, or a name with an extension.
const PATH_TOKEN =
	/(?:^|[\s`'"(\[{,])((?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+|[\w@+-][\w@.+-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?=$|[\s`'")\]},.;:!?])/gu

/** The relative paths a text names, plus the touched files whose path or name it mentions. */
export function pathsNamed(
	root: string,
	text: string,
	files: readonly string[] = [],
): readonly string[] {
	const found = new Set<string>()
	for (const match of text.matchAll(PATH_TOKEN)) {
		const token = match[1]
		if (token) found.add(token.replace(/^\.\//u, '').replace(/\.+$/u, ''))
	}
	for (const file of files) {
		const rel = isAbsolute(file) ? inside(root, file) : file
		if (rel === undefined) continue
		if (text.includes(rel) || text.includes(basename(rel))) found.add(rel)
	}
	return [...found]
}

/**
 * The anchors for what a memory's text names. A candidate that is not a file
 * inside the project (absent, a folder, outside by any route) is dropped.
 * Never throws.
 */
export async function recordAnchors(input: {
	readonly root: string
	readonly text: string
	readonly files?: readonly string[]
	readonly fs?: AnchorFs
}): Promise<readonly MemoryAnchor[]> {
	const fs = input.fs ?? nodeAnchorFs
	const anchors: MemoryAnchor[] = []
	for (const candidate of pathsNamed(input.root, input.text, input.files)) {
		if (anchors.length >= ANCHOR_MAX) break
		try {
			const at = await locate(input.root, candidate, fs)
			if (!at || anchors.some((anchor) => anchor.path === at.rel)) continue
			const info = await fs.stat(at.real)
			if (!info) continue
			const sha256 =
				info.size <= ANCHOR_HASH_MAX_BYTES ? digest(await fs.readFile(at.real)) : undefined
			anchors.push({
				path: at.rel,
				size: info.size,
				mtimeMs: info.mtimeMs,
				...(sha256 ? { sha256 } : {}),
			})
		} catch {
			// Not there, not readable: nothing to anchor to.
		}
	}
	return anchors
}

/** The anchors in a record's metadata; entries that are not well formed are dropped. */
export function anchorsOf(
	metadata: Readonly<Record<string, unknown>> | undefined,
): readonly MemoryAnchor[] {
	const raw = metadata?.[ANCHORS_KEY]
	if (!Array.isArray(raw)) return []
	const out: MemoryAnchor[] = []
	for (const item of raw.slice(0, ANCHOR_MAX)) {
		if (typeof item !== 'object' || item === null) continue
		const { path, size, mtimeMs, sha256 } = item as Record<string, unknown>
		if (typeof path !== 'string' || path === '' || path.length > 300) continue
		if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) continue
		if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) continue
		if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)))
			continue
		out.push({ path, size, mtimeMs, ...(sha256 ? { sha256 } : {}) })
	}
	return out
}

export interface AnchorVerdict {
	/** The first anchor that no longer holds, when one does not. */
	readonly broken?: { readonly path: string; readonly why: 'gone' | 'changed' }
	/** How many anchors were checked: those inside the project. */
	readonly checked: number
}

/** Check each anchor against the file now. Never throws; a path outside the project is skipped. */
export async function checkAnchors(input: {
	readonly root: string
	readonly anchors: readonly MemoryAnchor[]
	readonly fs?: AnchorFs
}): Promise<AnchorVerdict> {
	const fs = input.fs ?? nodeAnchorFs
	let checked = 0
	let broken: AnchorVerdict['broken']
	for (const anchor of input.anchors.slice(0, ANCHOR_MAX)) {
		try {
			if (isAbsolute(anchor.path)) continue
			let at: Awaited<ReturnType<typeof locate>>
			try {
				at = await locate(input.root, anchor.path, fs)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
				// A lexically inside path that is gone.
				if (inside(input.root, resolve(input.root, anchor.path)) === undefined) continue
				checked += 1
				broken ??= { path: anchor.path, why: 'gone' }
				continue
			}
			// Outside by a link or a `..`: not this project's, not ours to judge.
			if (!at) continue
			checked += 1
			const info = await fs.stat(at.real)
			if (!info) {
				broken ??= { path: anchor.path, why: 'gone' }
				continue
			}
			if (info.size === anchor.size && info.mtimeMs === anchor.mtimeMs) continue
			if (anchor.sha256 && info.size <= ANCHOR_HASH_MAX_BYTES) {
				if (digest(await fs.readFile(at.real)) === anchor.sha256) continue
			}
			broken ??= { path: anchor.path, why: 'changed' }
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				checked += 1
				broken ??= { path: anchor.path, why: 'gone' }
			}
			// Any other failure (permissions) says nothing about the file.
		}
	}
	return { checked, ...(broken ? { broken } : {}) }
}

/** The line recall adds to a memory whose anchor does not hold. */
export function cautionFor(broken: NonNullable<AnchorVerdict['broken']>): string {
	const path = broken.path.replace(/[^\x20-\x7e]/gu, '?').slice(0, 120)
	return `may be out of date: ${path} ${broken.why === 'gone' ? 'no longer exists' : 'has changed'} since this was saved`
}

/** What the usage file offers to the check: a broken anchor is noted, a held one lifts the note. */
export interface AnchorUsage {
	anchorsBroken(id: string): void
	anchorsHeld(id: string): void
}

/**
 * The check recall runs for each record it is about to show. Without anchors
 * it does nothing; with them it reads the project, tells `usage`, and answers
 * the caution text or `undefined`.
 */
export function createAnchorCaution(deps: {
	readonly root: string
	readonly usage?: AnchorUsage
	readonly fs?: AnchorFs
}): (record: {
	readonly id: string
	readonly metadata?: Readonly<Record<string, unknown>>
}) => Promise<string | undefined> {
	return async (record) => {
		const anchors = anchorsOf(record.metadata)
		if (anchors.length === 0) return undefined
		const verdict = await checkAnchors({
			root: deps.root,
			anchors,
			...(deps.fs ? { fs: deps.fs } : {}),
		})
		if (verdict.broken) {
			deps.usage?.anchorsBroken(record.id)
			return cautionFor(verdict.broken)
		}
		if (verdict.checked > 0) deps.usage?.anchorsHeld(record.id)
		return undefined
	}
}
