/**
 * Working-tree changes behind the Desktop Changes review: what differs from HEAD, and both
 * sides of one changed file. Read-only. Git runs through the hardened runner of
 * desktop-host-header (no shell, no fsmonitor hook, no optional locks, a timeout and an
 * output cap); working-tree files are read under the same confinement as Desktop's project
 * files, so a path from the renderer can never leave the folder or reach `.git`.
 */
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { join, relative as relativePath, sep } from 'node:path'
import { type GitRunBytes, runGitBytes } from './desktop-host-header.js'

export type ProjectChangeStatus =
	| 'modified'
	| 'added'
	| 'deleted'
	| 'renamed'
	| 'untracked'
	| 'binary'

export interface ProjectChangeFile {
	path: string
	status: ProjectChangeStatus
	added: number
	removed: number
	oldPath?: string
	/** Set on a renamed file whose content is not text, so the rename itself stays visible. */
	binary?: true
}

export interface ProjectChanges {
	files: ProjectChangeFile[]
	truncated: boolean
}

export interface ProjectDiff {
	before: string | null
	after: string | null
	binary: boolean
	truncated: boolean
}

export const CHANGES_MAX_FILES = 2_000
/** Untracked files whose lines are counted; the rest list as new with no count. */
export const CHANGES_UNTRACKED_COUNTED = 200
export const CHANGES_TIMEOUT_MS = 10_000
export const CHANGES_OUTPUT_CAP = 1024 * 1024
export const DIFF_TEXT_MAX_BYTES = 2 * 1024 * 1024
const PATH_MAX_LENGTH = 1_024
// git's well-known empty tree: diffing it against the working tree lists every tracked file as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

const outside = () => new Error('That path is not inside this project.')

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
const caseFold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)

function contains(root: string, target: string): boolean {
	if (target === root) return true
	const prefix = root.endsWith(sep) ? root : root + sep
	return caseFold(target).startsWith(caseFold(prefix))
}

/** The segments of a project-relative path, or null when the text itself is unacceptable. */
export function projectPathSegments(path: unknown): string[] | null {
	if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX_LENGTH) return null
	// A backslash is a separator only on Windows; on POSIX it is an ordinary filename character.
	if (CONTROL.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
	if (process.platform === 'win32' && path.includes('\\')) return null
	if (path.includes('�')) return null
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
	if (segments.length === 0 || segments[0] === '~') return null
	for (const segment of segments)
		if (segment === '..' || segment.toLowerCase() === '.git') return null
	return segments
}

/** Validates the text of `path`, then resolves symlinks and checks the result stays inside `root`. */
export async function confineChangePath(
	root: string,
	path: unknown,
): Promise<{ segments: string[]; absolute: string | null }> {
	const segments = projectPathSegments(path)
	if (!segments) throw outside()
	const realRoot = await realpath(root)
	let real: string
	try {
		real = await realpath(join(realRoot, ...segments))
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		// Nothing exists there, so nothing can be read: a deleted file has no working side.
		if (code === 'ENOENT' || code === 'ENOTDIR') return { segments, absolute: null }
		throw new Error('That path is not available.')
	}
	if (!contains(realRoot, real)) throw outside()
	// A link back into .git must not be a way around the name check above.
	if (
		relativePath(realRoot, real)
			.split(sep)
			.some((segment) => segment.toLowerCase() === '.git')
	)
		throw outside()
	return { segments, absolute: real }
}

interface NumstatRow {
	path: string
	oldPath?: string
	added: number
	removed: number
	binary: boolean
}

/** Cut a `-z` stream at its last NUL so a capped read never yields a half record. */
function completeTokens(data: Buffer, truncated: boolean): string[] {
	const whole = !truncated && data.length > 0 && data[data.length - 1] === 0
	const end = whole ? data.length - 1 : data.lastIndexOf(0)
	if (end <= 0 && !(whole && end === 0)) return []
	return data.subarray(0, end).toString('utf8').split('\0')
}

/** `git diff --numstat -z`: `A\tR\tpath\0`, or `A\tR\t\0old\0new\0` for a rename; `-\t-` is binary. */
export function parseNumstat(data: Buffer, truncated = false): NumstatRow[] {
	const tokens = completeTokens(data, truncated)
	const rows: NumstatRow[] = []
	for (let index = 0; index < tokens.length; ) {
		const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[index] as string)
		if (!match) {
			index += 1
			continue
		}
		const binary = match[1] === '-' || match[2] === '-'
		const counts = {
			added: binary ? 0 : Number(match[1]),
			removed: binary ? 0 : Number(match[2]),
			binary,
		}
		if (match[3] === '') {
			const oldPath = tokens[index + 1]
			const path = tokens[index + 2]
			index += 3
			if (oldPath === undefined || path === undefined) break
			rows.push({ ...counts, path, oldPath })
		} else {
			rows.push({ ...counts, path: match[3] as string })
			index += 1
		}
	}
	return rows
}

/** `git diff --name-status -z`: `M\0path\0`, `R100\0old\0new\0`. Keyed by the current path. */
export function parseNameStatus(
	data: Buffer,
	truncated = false,
): Map<string, { letter: string; oldPath?: string }> {
	const tokens = completeTokens(data, truncated)
	const out = new Map<string, { letter: string; oldPath?: string }>()
	for (let index = 0; index < tokens.length; ) {
		const letter = (tokens[index] as string).charAt(0)
		if (letter === 'R' || letter === 'C') {
			const oldPath = tokens[index + 1]
			const path = tokens[index + 2]
			index += 3
			if (oldPath === undefined || path === undefined) break
			out.set(path, { letter, oldPath })
		} else {
			const path = tokens[index + 1]
			index += 2
			if (path === undefined) break
			out.set(path, { letter })
		}
	}
	return out
}

/** Lines a text would add: the count of newlines, plus an unterminated last line. */
export function countLines(text: string): number {
	if (text.length === 0) return 0
	let count = 0
	for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) count++
	return text.endsWith('\n') ? count : count + 1
}

type Decoded = { text: string } | { binary: true }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** Strict UTF-8 without NUL bytes, otherwise the content is binary. */
export function decodeText(bytes: Buffer): Decoded {
	if (bytes.includes(0)) return { binary: true }
	try {
		return { text: decoder.decode(bytes) }
	} catch {
		return { binary: true }
	}
}

async function readCapped(
	absolute: string,
	max: number,
): Promise<{ bytes: Buffer; tooLarge: boolean }> {
	const handle = await open(absolute, 'r')
	try {
		// Size the buffer to the file, so counting many small untracked files does not allocate the cap each time.
		const { size } = await handle.stat()
		const buffer = Buffer.alloc(Math.min(size, max) + 1)
		let filled = 0
		while (filled < buffer.length) {
			const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
			if (bytesRead === 0) break
			filled += bytesRead
		}
		return {
			bytes: buffer.subarray(0, Math.min(filled, max)),
			tooLarge: filled > max,
		}
	} finally {
		await handle.close()
	}
}

const exitCode = (error: unknown) => (error as { code?: unknown }).code
const timedOut = (error: unknown) =>
	(error as { killed?: unknown }).killed === true ||
	(error as { signal?: unknown }).signal === 'SIGTERM' ||
	exitCode(error) === 'ETIMEDOUT'
const tooSlow = () => new Error('Reading the changes took too long.')

export function createProjectChanges(options: { run?: GitRunBytes } = {}) {
	const run = options.run ?? runGitBytes
	const git = async (args: readonly string[], cwd: string, maxBytes = CHANGES_OUTPUT_CAP) => {
		try {
			return await run(args, cwd, { maxBytes, timeoutMs: CHANGES_TIMEOUT_MS })
		} catch (error) {
			if (timedOut(error)) throw tooSlow()
			throw error
		}
	}

	/** Where the comparison starts: HEAD, or the empty tree in a repository with no commit yet. */
	const baseline = async (cwd: string): Promise<string> => {
		try {
			await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd, 4096)
			return 'HEAD'
		} catch (error) {
			if (exitCode(error) === 1) return EMPTY_TREE
			throw error
		}
	}

	const insideRepository = async (cwd: string): Promise<boolean> => {
		try {
			const { data } = await git(['rev-parse', '--is-inside-work-tree'], cwd, 4096)
			return data.toString('utf8').trim() === 'true'
		} catch (error) {
			if (error instanceof Error && error.message === tooSlow().message) throw error
			// Not a repository, or git is missing: both read as "no changes view".
			return false
		}
	}

	const diffArgs = (kind: '--numstat' | '--name-status', base: string) => [
		'diff',
		kind,
		'-z',
		'--find-renames',
		'--no-ext-diff',
		'--no-textconv',
		'--no-color',
		'--relative',
		base,
		'--',
	]

	async function countUntracked(cwd: string, path: string): Promise<ProjectChangeFile> {
		const plain: ProjectChangeFile = {
			path,
			status: 'untracked',
			added: 0,
			removed: 0,
		}
		try {
			const confined = await confineChangePath(cwd, path)
			if (!confined.absolute) return plain
			// A link is listed as a file of its own; never follow it to count lines.
			if (!(await lstat(join(cwd, ...confined.segments))).isFile()) return plain
			const { bytes, tooLarge } = await readCapped(confined.absolute, DIFF_TEXT_MAX_BYTES)
			if (tooLarge) return plain
			const decoded = decodeText(bytes)
			if ('binary' in decoded) return { ...plain, status: 'binary' }
			return { ...plain, added: countLines(decoded.text) }
		} catch {
			return plain
		}
	}

	async function changes(cwd: string): Promise<ProjectChanges | null> {
		if (!(await insideRepository(cwd))) return null
		const base = await baseline(cwd)
		const [numstat, nameStatus, others] = await Promise.all([
			git(diffArgs('--numstat', base), cwd),
			git(diffArgs('--name-status', base), cwd),
			git(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
		])
		let truncated = numstat.truncated || nameStatus.truncated || others.truncated
		const letters = parseNameStatus(nameStatus.data, nameStatus.truncated)
		const files: ProjectChangeFile[] = []
		for (const row of parseNumstat(numstat.data, numstat.truncated)) {
			if (!projectPathSegments(row.path)) continue
			const known = letters.get(row.path)
			const renamed = known?.letter === 'R' || row.oldPath !== undefined
			const oldPath = row.oldPath ?? known?.oldPath
			const status: ProjectChangeStatus = renamed
				? 'renamed'
				: row.binary
					? 'binary'
					: known?.letter === 'A'
						? 'added'
						: known?.letter === 'D'
							? 'deleted'
							: 'modified'
			files.push({
				path: row.path,
				status,
				added: row.added,
				removed: row.removed,
				...(renamed && row.binary ? { binary: true as const } : {}),
				...(renamed && oldPath !== undefined && projectPathSegments(oldPath) ? { oldPath } : {}),
			})
		}
		const untracked = completeTokens(others.data, others.truncated).filter(
			(path) => projectPathSegments(path) !== null,
		)
		const room = Math.max(0, CHANGES_MAX_FILES - files.length)
		if (files.length > CHANGES_MAX_FILES || untracked.length > room) truncated = true
		for (const [index, path] of untracked.slice(0, room).entries())
			files.push(
				index < CHANGES_UNTRACKED_COUNTED
					? await countUntracked(cwd, path)
					: { path, status: 'untracked', added: 0, removed: 0 },
			)
		files.splice(CHANGES_MAX_FILES)
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		return { files, truncated }
	}

	/** The path a renamed file had in HEAD, when `path` is a rename target. */
	async function renamedFrom(cwd: string, path: string): Promise<string | undefined> {
		try {
			const { data, truncated } = await git(diffArgs('--name-status', 'HEAD'), cwd)
			const hit = parseNameStatus(data, truncated).get(path)
			return hit?.letter === 'R' && hit.oldPath && projectPathSegments(hit.oldPath)
				? hit.oldPath
				: undefined
		} catch {
			return undefined
		}
	}

	async function headText(
		cwd: string,
		path: string,
	): Promise<{ bytes: Buffer | null; tooLarge: boolean }> {
		try {
			const shown = await git(['cat-file', 'blob', `HEAD:./${path}`], cwd, DIFF_TEXT_MAX_BYTES)
			// cat-file blob, not show: show prints a tree listing for a directory. An oversized blob is cut at the cap, which is never a faithful "before".
			return shown.truncated
				? { bytes: null, tooLarge: true }
				: { bytes: shown.data, tooLarge: false }
		} catch (error) {
			if (error instanceof Error && error.message === tooSlow().message) throw error
			// Not in HEAD (new file) or no commit yet.
			return { bytes: null, tooLarge: false }
		}
	}

	async function diff(cwd: string, path: unknown): Promise<ProjectDiff> {
		const confined = await confineChangePath(cwd, path)
		const relative = confined.segments.join('/')
		let after: Buffer | null = null
		if (confined.absolute) {
			if (!(await stat(confined.absolute)).isFile()) throw new Error('That path is not a file.')
			const read = await readCapped(confined.absolute, DIFF_TEXT_MAX_BYTES)
			if (read.tooLarge) return { before: null, after: null, binary: false, truncated: true }
			after = read.bytes
		}
		let head = await headText(cwd, relative)
		if (head.bytes === null && !head.tooLarge && after !== null) {
			const old = await renamedFrom(cwd, relative)
			if (old) head = await headText(cwd, old)
		}
		if (head.tooLarge) return { before: null, after: null, binary: false, truncated: true }
		if (head.bytes === null && after === null) throw new Error('That file was not found.')
		const sides = [head.bytes, after].map((bytes) => (bytes === null ? null : decodeText(bytes)))
		if (sides.some((side) => side !== null && 'binary' in side))
			return { before: null, after: null, binary: true, truncated: false }
		const text = (side: Decoded | null) => (side && 'text' in side ? side.text : null)
		return {
			before: text(sides[0] as Decoded | null),
			after: text(sides[1] as Decoded | null),
			binary: false,
			truncated: false,
		}
	}

	return { changes, diff }
}
