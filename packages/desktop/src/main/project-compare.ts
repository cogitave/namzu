/**
 * What a Changes pane base other than "uncommitted" needs from git: the branches and the newest
 * commits to compare against, the changed files against a branch's fork point or a commit, and
 * both sides of one of those files. Read-only. Git runs with no shell, no repository hooks and a
 * timeout and an output cap; a ref or hash from the renderer is checked before it reaches git, and
 * a path is confined to the project folder before a working-tree file is read.
 */
import { execFile } from 'node:child_process'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { join, relative as relativePath, sep } from 'node:path'
import type {
	ProjectChangeFile,
	ProjectChangesView,
	ProjectCompareBase,
	ProjectCompareReply,
	ProjectCompareRequest,
	ProjectDiffView,
} from '../shared/protocol.js'

export const COMPARE_MAX_FILES = 2_000
export const COMPARE_UNTRACKED_COUNTED = 200
export const COMPARE_TIMEOUT_MS = 10_000
export const COMPARE_OUTPUT_CAP = 1024 * 1024
export const COMPARE_TEXT_MAX_BYTES = 2 * 1024 * 1024
export const COMPARE_MAX_BRANCHES = 200
export const COMPARE_COMMITS = 50
const PATH_MAX_LENGTH = 1_024
// git's well-known empty tree: comparing against it lists every file as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const DEFAULT_NAMES = ['main', 'master', 'trunk', 'develop']

export type GitBytes = (
	args: readonly string[],
	cwd: string,
	limits: { maxBytes: number; timeoutMs: number },
) => Promise<{ data: Buffer; truncated: boolean }>

export const runGitBytes: GitBytes = (args, cwd, limits) =>
	new Promise((resolve, reject) => {
		execFile(
			'git',
			['-c', 'core.fsmonitor=false', '--no-optional-locks', ...args],
			{
				cwd,
				timeout: limits.timeoutMs,
				maxBuffer: limits.maxBytes,
				encoding: 'buffer',
				env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
				windowsHide: true,
			},
			(error, stdout) => {
				if (!error) return resolve({ data: stdout, truncated: false })
				if ((error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
					return resolve({ data: stdout, truncated: true })
				reject(error)
			},
		)
	})

const REF_NAME = /^[A-Za-z0-9._/-]{1,200}$/
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i

/** A branch or tag name safe to hand to git: no option look-alike, no `..`, no odd characters. */
export function validRef(ref: unknown): ref is string {
	return (
		typeof ref === 'string' &&
		REF_NAME.test(ref) &&
		!ref.startsWith('-') &&
		!ref.startsWith('/') &&
		!ref.endsWith('/') &&
		!ref.includes('..') &&
		!ref.includes('//')
	)
}

export function validCommit(sha: unknown): sha is string {
	return typeof sha === 'string' && COMMIT_HASH.test(sha)
}

export function validBase(base: unknown): base is ProjectCompareBase {
	if (!base || typeof base !== 'object') return false
	const { kind, ref, sha } = base as Record<string, unknown>
	return (
		kind === 'head' ||
		(kind === 'branch' && validRef(ref)) ||
		(kind === 'commit' && validCommit(sha))
	)
}

/** The request the renderer sent, or null when any part of it is not acceptable. */
export function parseRequest(request: unknown): ProjectCompareRequest | null {
	if (!request || typeof request !== 'object') return null
	const r = request as Record<string, unknown>
	if (r.op === 'branches' || r.op === 'commits') return { op: r.op }
	if (r.op === 'changes' && validBase(r.base))
		return {
			op: 'changes',
			base: r.base,
			...(r.hideWhitespace === true ? { hideWhitespace: true } : {}),
		}
	if (r.op === 'diff' && validBase(r.base) && projectPathSegments(r.path))
		return { op: 'diff', base: r.base, path: r.path as string }
	return null
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/

/** The segments of a project-relative path, or null when the text itself is unacceptable. */
export function projectPathSegments(path: unknown): string[] | null {
	if (typeof path !== 'string' || path.length === 0 || path.length > PATH_MAX_LENGTH) return null
	if (CONTROL.test(path) || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null
	if (process.platform === 'win32' && path.includes('\\')) return null
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
	if (segments.length === 0 || segments[0] === '~') return null
	for (const segment of segments)
		if (segment === '..' || segment.toLowerCase() === '.git') return null
	return segments
}

const caseFold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)

async function confine(
	root: string,
	path: unknown,
): Promise<{ segments: string[]; absolute: string | null }> {
	const segments = projectPathSegments(path)
	if (!segments) throw new Error('That path is not inside this project.')
	const realRoot = await realpath(root)
	let real: string
	try {
		real = await realpath(join(realRoot, ...segments))
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT' || code === 'ENOTDIR') return { segments, absolute: null }
		throw new Error('That path is not available.')
	}
	const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
	if (real !== realRoot && !caseFold(real).startsWith(caseFold(prefix)))
		throw new Error('That path is not inside this project.')
	if (
		relativePath(realRoot, real)
			.split(sep)
			.some((segment) => segment.toLowerCase() === '.git')
	)
		throw new Error('That path is not inside this project.')
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

export function countLines(text: string): number {
	if (text.length === 0) return 0
	let count = 0
	for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) count++
	return text.endsWith('\n') ? count : count + 1
}

type Decoded = { text: string } | { binary: true }
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function decodeText(bytes: Buffer): Decoded {
	if (bytes.includes(0)) return { binary: true }
	try {
		return { text: decoder.decode(bytes) }
	} catch {
		return { binary: true }
	}
}

async function readCapped(absolute: string, max: number) {
	const handle = await open(absolute, 'r')
	try {
		const { size } = await handle.stat()
		const buffer = Buffer.alloc(Math.min(size, max) + 1)
		let filled = 0
		while (filled < buffer.length) {
			const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
			if (bytesRead === 0) break
			filled += bytesRead
		}
		return { bytes: buffer.subarray(0, Math.min(filled, max)), tooLarge: filled > max }
	} finally {
		await handle.close()
	}
}

/** Where a comparison starts and, for a commit, where it ends; no `to` means the working tree. */
export interface Resolved {
	from: string
	to?: string
}

const slow = () => new Error('Reading the changes took too long.')
const exitCode = (error: unknown) => (error as { code?: unknown }).code

export function createProjectCompare(options: { run?: GitBytes } = {}) {
	const run = options.run ?? runGitBytes
	const git = async (args: readonly string[], cwd: string, maxBytes = COMPARE_OUTPUT_CAP) => {
		try {
			return await run(args, cwd, { maxBytes, timeoutMs: COMPARE_TIMEOUT_MS })
		} catch (error) {
			if (
				(error as { killed?: unknown }).killed === true ||
				(error as { signal?: unknown }).signal === 'SIGTERM'
			)
				throw slow()
			throw error
		}
	}
	const text = async (args: readonly string[], cwd: string, maxBytes = 64 * 1024) =>
		(await git(args, cwd, maxBytes)).data.toString('utf8').trim()
	const optional = async (args: readonly string[], cwd: string) => {
		try {
			return await text(args, cwd)
		} catch (error) {
			if (error instanceof Error && error.message === slow().message) throw error
			return ''
		}
	}

	async function insideRepository(cwd: string): Promise<boolean> {
		try {
			return (await text(['rev-parse', '--is-inside-work-tree'], cwd, 4096)) === 'true'
		} catch (error) {
			if (error instanceof Error && error.message === slow().message) throw error
			return false
		}
	}

	async function resolve(cwd: string, base: ProjectCompareBase): Promise<Resolved> {
		if (base.kind === 'head') {
			try {
				await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd, 4096)
				return { from: 'HEAD' }
			} catch (error) {
				if (exitCode(error) === 1) return { from: EMPTY_TREE }
				throw error
			}
		}
		if (base.kind === 'branch') {
			const point = await optional(['merge-base', base.ref, 'HEAD'], cwd)
			if (!point) throw new Error(`Couldn’t compare with ${base.ref}.`)
			return { from: point }
		}
		const full = await optional(['rev-parse', '--verify', '-q', `${base.sha}^{commit}`], cwd)
		if (!full) throw new Error('That commit was not found.')
		const parent = await optional(['rev-parse', '--verify', '-q', `${full}^`], cwd)
		return { from: parent ? `${full}^` : EMPTY_TREE, to: full }
	}

	const diffArgs = (
		kind: '--numstat' | '--name-status',
		r: Resolved,
		hideWhitespace: boolean,
	): string[] => [
		'diff',
		kind,
		'-z',
		'--find-renames',
		'--no-ext-diff',
		'--no-textconv',
		'--no-color',
		'--relative',
		...(hideWhitespace ? ['-w'] : []),
		r.from,
		...(r.to ? [r.to] : []),
		'--',
	]

	async function branches(cwd: string) {
		if (!(await insideRepository(cwd))) return null
		const listing = (
			await git(
				[
					'for-each-ref',
					'--sort=-committerdate',
					'--format=%(refname)',
					'refs/heads',
					'refs/remotes',
				],
				cwd,
			)
		).data
			.toString('utf8')
			.split('\n')
		const found: { name: string; remote: boolean }[] = []
		for (const line of listing) {
			const remote = line.startsWith('refs/remotes/')
			const name = remote ? line.slice('refs/remotes/'.length) : line.replace(/^refs\/heads\//, '')
			if (!line || remote === line.startsWith('refs/heads/') || /(^|\/)HEAD$/.test(name)) continue
			if (!validRef(name)) continue
			found.push({ name, remote })
			if (found.length >= COMPARE_MAX_BRANCHES) break
		}
		const current = (await optional(['symbolic-ref', '--short', '-q', 'HEAD'], cwd)) || null
		const originHead = await optional(
			['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'],
			cwd,
		)
		const named = originHead.replace(/^origin\//, '')
		const local = new Set(found.filter((b) => !b.remote).map((b) => b.name))
		const remoteNames = new Set(found.filter((b) => b.remote).map((b) => b.name))
		const candidates = [named, ...DEFAULT_NAMES].filter(Boolean)
		let defaultBranch: string | null = null
		for (const name of candidates) {
			if (local.has(name)) defaultBranch = name
			else if (remoteNames.has(`origin/${name}`)) defaultBranch = `origin/${name}`
			if (defaultBranch) break
		}
		return { current, defaultBranch, branches: found }
	}

	async function commits(cwd: string) {
		if (!(await insideRepository(cwd))) return null
		let raw = ''
		try {
			raw = (
				await git(['log', `-${COMPARE_COMMITS}`, '--format=%H%x1f%h%x1f%s', 'HEAD', '--'], cwd)
			).data.toString('utf8')
		} catch {
			return { commits: [], total: 0 }
		}
		const list = raw
			.split('\n')
			.filter(Boolean)
			.map((line) => {
				const [sha = '', short = '', subject = ''] = line.split('\x1f')
				return { sha, short, subject: subject.replace(CONTROL, ' ').slice(0, 300) }
			})
			.filter((entry) => validCommit(entry.sha))
		const counted = Number(await optional(['rev-list', '--count', 'HEAD'], cwd))
		return { commits: list, total: Number.isFinite(counted) && counted > 0 ? counted : list.length }
	}

	async function countUntracked(cwd: string, path: string): Promise<ProjectChangeFile> {
		const plain: ProjectChangeFile = { path, status: 'untracked', added: 0, removed: 0 }
		try {
			const confined = await confine(cwd, path)
			if (!confined.absolute) return plain
			if (!(await lstat(join(cwd, ...confined.segments))).isFile()) return plain
			const { bytes, tooLarge } = await readCapped(confined.absolute, COMPARE_TEXT_MAX_BYTES)
			if (tooLarge) return plain
			const decoded = decodeText(bytes)
			if ('binary' in decoded) return { ...plain, status: 'binary' }
			return { ...plain, added: countLines(decoded.text) }
		} catch {
			return plain
		}
	}

	async function changes(
		cwd: string,
		base: ProjectCompareBase,
		hideWhitespace: boolean,
	): Promise<ProjectChangesView | null> {
		if (!(await insideRepository(cwd))) return null
		const r = await resolve(cwd, base)
		const [numstat, nameStatus, others] = await Promise.all([
			git(diffArgs('--numstat', r, hideWhitespace), cwd),
			git(diffArgs('--name-status', r, hideWhitespace), cwd),
			r.to
				? Promise.resolve({ data: Buffer.alloc(0), truncated: false })
				: git(['ls-files', '--others', '--exclude-standard', '-z'], cwd),
		])
		let truncated = numstat.truncated || nameStatus.truncated || others.truncated
		const letters = parseNameStatus(nameStatus.data, nameStatus.truncated)
		const files: ProjectChangeFile[] = []
		for (const row of parseNumstat(numstat.data, numstat.truncated)) {
			if (!projectPathSegments(row.path)) continue
			const known = letters.get(row.path)
			const renamed = known?.letter === 'R' || row.oldPath !== undefined
			const oldPath = row.oldPath ?? known?.oldPath
			const status: ProjectChangeFile['status'] = renamed
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
				...(hideWhitespace && !row.binary && row.added === 0 && row.removed === 0
					? { whitespaceOnly: true as const }
					: {}),
			})
		}
		const untracked = completeTokens(others.data, others.truncated).filter(
			(path) => projectPathSegments(path) !== null,
		)
		const room = Math.max(0, COMPARE_MAX_FILES - files.length)
		if (files.length > COMPARE_MAX_FILES || untracked.length > room) truncated = true
		for (const [index, path] of untracked.slice(0, room).entries())
			files.push(
				index < COMPARE_UNTRACKED_COUNTED
					? await countUntracked(cwd, path)
					: { path, status: 'untracked', added: 0, removed: 0 },
			)
		files.splice(COMPARE_MAX_FILES)
		files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
		return { files, truncated }
	}

	async function blob(cwd: string, rev: string, path: string) {
		if (rev === EMPTY_TREE) return { bytes: null, tooLarge: false }
		try {
			const shown = await git(['cat-file', 'blob', `${rev}:./${path}`], cwd, COMPARE_TEXT_MAX_BYTES)
			return shown.truncated
				? { bytes: null, tooLarge: true }
				: { bytes: shown.data, tooLarge: false }
		} catch (error) {
			if (error instanceof Error && error.message === slow().message) throw error
			return { bytes: null, tooLarge: false }
		}
	}

	async function diff(
		cwd: string,
		base: ProjectCompareBase,
		path: unknown,
	): Promise<ProjectDiffView> {
		const confined = await confine(cwd, path)
		const relative = confined.segments.join('/')
		const r = await resolve(cwd, base)
		let after: Buffer | null = null
		if (r.to) {
			const end = await blob(cwd, r.to, relative)
			if (end.tooLarge) return { before: null, after: null, binary: false, truncated: true }
			after = end.bytes
		} else if (confined.absolute) {
			if (!(await stat(confined.absolute)).isFile()) throw new Error('That path is not a file.')
			const read = await readCapped(confined.absolute, COMPARE_TEXT_MAX_BYTES)
			if (read.tooLarge) return { before: null, after: null, binary: false, truncated: true }
			after = read.bytes
		}
		let before = await blob(cwd, r.from, relative)
		if (before.bytes === null && !before.tooLarge && after !== null) {
			try {
				const names = await git(diffArgs('--name-status', r, false), cwd)
				const hit = parseNameStatus(names.data, names.truncated).get(relative)
				if (hit?.letter === 'R' && hit.oldPath && projectPathSegments(hit.oldPath))
					before = await blob(cwd, r.from, hit.oldPath)
			} catch {
				// No rename to follow: the file is new on this side.
			}
		}
		if (before.tooLarge) return { before: null, after: null, binary: false, truncated: true }
		if (before.bytes === null && after === null) throw new Error('That file was not found.')
		const sides = [before.bytes, after].map((bytes) => (bytes === null ? null : decodeText(bytes)))
		if (sides.some((side) => side !== null && 'binary' in side))
			return { before: null, after: null, binary: true, truncated: false }
		const pick = (side: Decoded | null) => (side && 'text' in side ? side.text : null)
		return {
			before: pick(sides[0] as Decoded | null),
			after: pick(sides[1] as Decoded | null),
			binary: false,
			truncated: false,
		}
	}

	return async function compare(
		cwd: string,
		request: unknown,
	): Promise<ProjectCompareReply | null> {
		const parsed = parseRequest(request)
		if (!parsed) throw new Error('That comparison is not valid.')
		if (parsed.op === 'branches') {
			const view = await branches(cwd)
			return view && { op: 'branches', ...view }
		}
		if (parsed.op === 'commits') {
			const view = await commits(cwd)
			return view && { op: 'commits', ...view }
		}
		if (parsed.op === 'changes') {
			const view = await changes(cwd, parsed.base, parsed.hideWhitespace === true)
			return view && { op: 'changes', ...view }
		}
		return { op: 'diff', ...(await diff(cwd, parsed.base, parsed.path)) }
	}
}
