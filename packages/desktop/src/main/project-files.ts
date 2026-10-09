import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { join, relative as relativePath, sep } from 'node:path'
import ignore from 'ignore'
import { parseDocument } from 'yaml'
import type {
	ProjectFileContent,
	ProjectFileEntry,
	ProjectLinkResolution,
} from '../shared/protocol.js'
import { sniffImage } from './link-preview.js'

/**
 * Everything here answers questions about a folder the user trusted, for a renderer and a
 * model that may name any path. The root is always one the operator resolved, every path is
 * validated as text and then again after symlinks are resolved, and errors are plain
 * sentences that never carry a path.
 */

export const LIST_MAX_ENTRIES = 5_000
export const INDEX_MAX_PATHS = 50_000
export const INDEX_MAX_DEPTH = 24
export const INDEX_BUDGET_MS = 3_000
export const INDEX_CACHE_MS = 30_000
export const TEXT_MAX_BYTES = 2 * 1024 * 1024
export const IMAGE_MAX_BYTES = 4 * 1024 * 1024
export const LINK_MAX_REFS = 200
const PATH_MAX_LENGTH = 1_024
const IGNORE_FILE_MAX_BYTES = 256 * 1024
const FRONTMATTER_MAX_CHARS = 64 * 1024
const FRONTMATTER_MAX_ROWS = 200
const FRONTMATTER_MAX_VALUE = 4_000
const LINE_MAX = 10_000_000

export class ProjectPathError extends Error {}

const outside = () => new ProjectPathError('That path is not inside this project.')
const missing = () => new ProjectPathError('That file or folder was not found.')
const hiddenFolder = () =>
	new ProjectPathError('That folder is hidden by this project’s ignore rules.')

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/
const isHiddenName = (name: string) => {
	const lower = name.toLowerCase()
	return lower === '.git' || lower === 'node_modules'
}
const caseFold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value)

function contains(root: string, target: string): boolean {
	if (target === root) return true
	const prefix = root.endsWith(sep) ? root : root + sep
	return caseFold(target).startsWith(caseFold(prefix))
}

export interface ConfinedPath {
	/** Fully resolved on disk, inside the root. */
	absolute: string
	/** Normalised project-relative path, '/' separated; '' for the root. */
	relative: string
}

/** Validates the text of `path`, joins it to `root`, resolves symlinks and checks containment. */
export async function confineProjectPath(root: string, path: unknown): Promise<ConfinedPath> {
	if (typeof path !== 'string' || path.length > PATH_MAX_LENGTH) throw outside()
	if (CONTROL.test(path) || path.includes('\\') || path.startsWith('/') || /^[A-Za-z]:/.test(path))
		throw outside()
	const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.')
	if (segments[0] === '~') throw outside()
	for (const segment of segments)
		if (segment === '..' || segment.toLowerCase() === '.git') throw outside()
	let real: string
	try {
		real = await realpath(join(root, ...segments))
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		if (code === 'ENOENT' || code === 'ENOTDIR') throw missing()
		throw new ProjectPathError('That path is not available.')
	}
	if (!contains(root, real)) throw outside()
	// A link back into .git must not be a way around the name check above.
	if (
		relativePath(root, real)
			.split(sep)
			.some((segment) => segment.toLowerCase() === '.git')
	)
		throw outside()
	return { absolute: real, relative: segments.join('/') }
}

interface IgnoreRule {
	base: string
	ig: ReturnType<typeof ignore>
}

async function readIgnoreFile(absolute: string): Promise<string | undefined> {
	try {
		const info = await lstat(absolute)
		// A symlinked ignore file could point anywhere; skipping it only shows more, never leaks.
		if (!info.isFile() || info.size > IGNORE_FILE_MAX_BYTES) return undefined
		return await readFile(absolute, 'utf8')
	} catch {
		return undefined
	}
}

async function ignoreRule(root: string, base: string): Promise<IgnoreRule | undefined> {
	const text = await readIgnoreFile(join(root, ...(base ? base.split('/') : []), '.gitignore'))
	return text === undefined ? undefined : { base, ig: ignore().add(text) }
}

async function rootRules(root: string): Promise<IgnoreRule[]> {
	const rules: IgnoreRule[] = []
	// Lowest precedence first: a later rule overrides an earlier one, as in git.
	const exclude = await readIgnoreFile(join(root, '.git', 'info', 'exclude'))
	if (exclude !== undefined) rules.push({ base: '', ig: ignore().add(exclude) })
	const top = await ignoreRule(root, '')
	if (top) rules.push(top)
	return rules
}

function isIgnored(rules: readonly IgnoreRule[], path: string, directory: boolean): boolean {
	let ignored = false
	for (const { base, ig } of rules) {
		if (base && !path.startsWith(`${base}/`)) continue
		const sub = base ? path.slice(base.length + 1) : path
		if (!sub) continue
		const verdict = ig.test(directory ? `${sub}/` : sub)
		if (verdict.ignored) ignored = true
		else if (verdict.unignored) ignored = false
	}
	return ignored
}

async function rulesAlong(root: string, segments: readonly string[]): Promise<IgnoreRule[]> {
	const rules = await rootRules(root)
	let base = ''
	for (const segment of segments) {
		const path = base ? `${base}/${segment}` : segment
		if (isHiddenName(segment) || isIgnored(rules, path, true)) throw hiddenFolder()
		base = path
		const next = await ignoreRule(root, base)
		if (next) rules.push(next)
	}
	return rules
}

/**
 * Reads follow the same visibility rules as listings: a file the tree would not show (ignored
 * by .gitignore or .git/info/exclude, or under an ignored folder or node_modules) is not
 * readable by exact path either, so a model or the renderer cannot reach a secrets file the
 * project keeps out of version control.
 */
async function assertVisible(root: string, relative: string): Promise<void> {
	const segments = relative ? relative.split('/') : []
	const rules = await rulesAlong(root, segments.slice(0, -1))
	const name = segments[segments.length - 1]
	if (name !== undefined && (isHiddenName(name) || isIgnored(rules, relative, false)))
		throw new ProjectPathError('That file is hidden by this project’s ignore rules.')
}

/**
 * File lists sort the way the person's language sorts names (Turkish puts ç, ğ, ı, ö, ş and ü
 * after c, g, h, o, s and u). `sensitivity: 'accent'` keeps "ışık" and "isik" apart. The app sets
 * its locale once Electron knows it; until then the system default applies.
 */
let collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' })
export function setFileSortLocale(locale: string | undefined): void {
	try {
		collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'accent' })
	} catch {
		collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'accent' })
	}
}
const byName = (left: ProjectFileEntry, right: ProjectFileEntry) =>
	collator.compare(left.name, right.name) || (left.name < right.name ? -1 : 1)

interface ScannedEntry {
	name: string
	directory: boolean
	symlink: boolean
}

/** One directory's visible entries; symlinks that leave the root are dropped. */
async function scan(
	root: string,
	absolute: string,
	base: string,
	rules: readonly IgnoreRule[],
	limits: { maxEntries: number; expired?: () => boolean } = {
		maxEntries: Number.POSITIVE_INFINITY,
	},
): Promise<ScannedEntry[]> {
	const found: ScannedEntry[] = []
	for (const entry of await readdir(absolute, { withFileTypes: true })) {
		// One huge folder must not outrun the caller's budget through serial link lookups.
		if (found.length >= limits.maxEntries || limits.expired?.()) break
		const name = entry.name
		if (isHiddenName(name) || CONTROL.test(name) || name.includes('\\')) continue
		let directory = entry.isDirectory()
		const symlink = entry.isSymbolicLink()
		if (symlink) {
			try {
				const target = await realpath(join(absolute, name))
				if (!contains(root, target)) continue
				directory = (await stat(target)).isDirectory()
			} catch {
				continue
			}
		} else if (!directory && !entry.isFile()) continue
		const path = base ? `${base}/${name}` : name
		if (isIgnored(rules, path, directory)) continue
		found.push({ name, directory, symlink })
	}
	return found
}

export interface ProjectFilesOptions {
	now?: () => number
	budgetMs?: number
	maxPaths?: number
	maxDepth?: number
}

interface CachedIndex {
	at: number
	value: { paths: string[]; truncated: boolean }
}

export class ProjectFiles {
	private readonly now: () => number
	private readonly budgetMs: number
	private readonly maxPaths: number
	private readonly maxDepth: number
	private readonly cache = new Map<string, CachedIndex>()
	/** Forget a project's cached index, for after the agent has written files. */
	invalidate(root?: string): void {
		if (root === undefined) this.cache.clear()
		else this.cache.delete(root)
	}

	private readonly walking = new Map<string, Promise<CachedIndex['value']>>()

	constructor(options: ProjectFilesOptions = {}) {
		this.now = options.now ?? Date.now
		this.budgetMs = options.budgetMs ?? INDEX_BUDGET_MS
		this.maxPaths = options.maxPaths ?? INDEX_MAX_PATHS
		this.maxDepth = options.maxDepth ?? INDEX_MAX_DEPTH
	}

	async list(root: string, dir: unknown): Promise<ProjectFileEntry[]> {
		const { absolute, relative } = await confineProjectPath(root, dir)
		const info = await stat(absolute)
		if (!info.isDirectory()) throw new ProjectPathError('That path is not a folder.')
		const segments = relative ? relative.split('/') : []
		const rules = await rulesAlong(root, segments)
		const entries = (
			await scan(root, absolute, relative, rules, { maxEntries: LIST_MAX_ENTRIES })
		).map(
			({ name, directory }): ProjectFileEntry => ({
				name,
				path: relative ? `${relative}/${name}` : name,
				kind: directory ? 'directory' : 'file',
			}),
		)
		const folders = entries.filter((entry) => entry.kind === 'directory').sort(byName)
		const plain = entries.filter((entry) => entry.kind === 'file').sort(byName)
		return [...folders, ...plain].slice(0, LIST_MAX_ENTRIES)
	}

	async index(root: string): Promise<{ paths: string[]; truncated: boolean }> {
		const cached = this.cache.get(root)
		if (cached && this.now() - cached.at < INDEX_CACHE_MS) return cached.value
		const running = this.walking.get(root)
		if (running) return running
		const walk = this.walk(root).then(
			(value) => {
				this.cache.set(root, { at: this.now(), value })
				// Projects are few; this only stops a long session from collecting stale roots.
				if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value as string)
				this.walking.delete(root)
				return value
			},
			(error) => {
				this.walking.delete(root)
				throw error
			},
		)
		this.walking.set(root, walk)
		return walk
	}

	private async walk(root: string): Promise<{ paths: string[]; truncated: boolean }> {
		const started = this.now()
		const paths: string[] = []
		let truncated = false
		const queue: { base: string; depth: number; rules: IgnoreRule[] }[] = [
			{ base: '', depth: 0, rules: await rootRules(root) },
		]
		for (let next = 0; next < queue.length && !truncated; next++) {
			if (this.now() - started > this.budgetMs) {
				truncated = true
				break
			}
			const { base, depth, rules } = queue[next] as (typeof queue)[number]
			// Let the main process answer other requests between directories.
			await new Promise<void>((resolve) => setImmediate(resolve))
			let found: ScannedEntry[]
			try {
				found = await scan(root, join(root, ...(base ? base.split('/') : [])), base, rules, {
					maxEntries: this.maxPaths,
					expired: () => this.now() - started > this.budgetMs,
				})
			} catch {
				continue
			}
			// A scan cut short by the clock or the per-folder cap left names unread.
			if (found.length >= this.maxPaths || this.now() - started > this.budgetMs) truncated = true
			for (const entry of found) {
				const path = base ? `${base}/${entry.name}` : entry.name
				if (entry.directory) {
					// A linked folder may loop back; the real tree is reached by its own path.
					if (entry.symlink) continue
					if (depth + 1 > this.maxDepth) {
						truncated = true
						continue
					}
					const nested = await ignoreRule(root, path)
					queue.push({ base: path, depth: depth + 1, rules: nested ? [...rules, nested] : rules })
					continue
				}
				if (paths.length >= this.maxPaths) {
					truncated = true
					break
				}
				paths.push(path)
			}
		}
		return { paths, truncated }
	}

	async read(root: string, path: unknown): Promise<ProjectFileContent> {
		const { absolute, relative } = await confineProjectPath(root, path)
		await assertVisible(root, relative)
		// O_NONBLOCK keeps a named pipe from parking the open (and a thread-pool thread) until a
		// writer shows up; O_NOFOLLOW refuses a link swapped in for the file itself.
		const handle = await open(
			absolute,
			constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
		)
		try {
			const info = await handle.stat()
			if (!info.isFile()) throw new ProjectPathError('That path is not a file.')
			// A folder on the way may have been swapped for a link after the check above; the
			// path must still resolve to the very file that was opened.
			const again = await confineProjectPath(root, relative)
			const now = await stat(again.absolute)
			if (now.ino !== info.ino || now.dev !== info.dev) throw outside()
			// A link inside the project can point at an ignored file; judge where it really lives.
			await assertVisible(root, relativePath(root, again.absolute).split(sep).join('/'))
			const size = info.size
			const head = Buffer.alloc(Math.min(size, 16))
			await handle.read(head, 0, head.length, 0)
			const mime = sniffImage(head, 'image')
			if (mime) {
				if (size > IMAGE_MAX_BYTES) return { path: relative, size, kind: 'too-large' }
				const bytes = await readAll(handle, size)
				return {
					path: relative,
					size,
					kind: 'image',
					image: `data:${mime};base64,${bytes.toString('base64')}`,
				}
			}
			if (size > TEXT_MAX_BYTES) return { path: relative, size, kind: 'too-large' }
			const bytes = await readAll(handle, size)
			let text: string
			try {
				if (bytes.includes(0)) throw new Error('binary')
				text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
			} catch {
				return { path: relative, size, kind: 'binary' }
			}
			const result: ProjectFileContent = { path: relative, size, kind: 'text', text }
			if (/\.(md|markdown)$/i.test(relative)) {
				const split = parseFrontmatter(text)
				if (split?.frontmatter) result.frontmatter = split.frontmatter
				result.markdown = split ? split.markdown : text
			}
			return result
		} finally {
			await handle.close()
		}
	}
}

async function readAll(
	handle: Awaited<ReturnType<typeof open>>,
	size: number,
): Promise<Buffer<ArrayBuffer>> {
	const buffer = Buffer.alloc(size)
	let total = 0
	while (total < size) {
		const { bytesRead } = await handle.read(buffer, total, size - total, total)
		if (bytesRead === 0) break
		total += bytesRead
	}
	return buffer.subarray(0, total)
}

/**
 * Splits a leading `---` YAML block off Markdown. A block that does not parse as a mapping
 * stays visible as one raw row, and an alias bomb trips the library's own expansion limit.
 */
export function parseFrontmatter(
	text: string,
): { frontmatter: { key: string; value: string }[]; markdown: string } | undefined {
	const source = text.startsWith('﻿') ? text.slice(1) : text
	const opening = /^---[ \t]*\r?\n/.exec(source)
	if (!opening) return undefined
	const rest = source.slice(opening[0].length)
	const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest)
	if (!closing || closing.index > FRONTMATTER_MAX_CHARS) return undefined
	const block = rest.slice(0, closing.index).replace(/\r?\n$/, '')
	const markdown = rest.slice(closing.index + closing[0].length)
	const raw = [{ key: 'frontmatter', value: block.slice(0, FRONTMATTER_MAX_VALUE) }]
	if (!block.trim()) return { frontmatter: [], markdown }
	try {
		const document = parseDocument(block, {
			schema: 'core',
			customTags: [],
			logLevel: 'silent',
		})
		if (document.errors.length) return { frontmatter: raw, markdown }
		const parsed: unknown = document.toJS({ maxAliasCount: 100 })
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
			return { frontmatter: raw, markdown }
		const rows = Object.entries(parsed as Record<string, unknown>)
			.slice(0, FRONTMATTER_MAX_ROWS)
			.map(([key, value]) => ({
				key: key.slice(0, 200),
				value: (typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value))).slice(
					0,
					FRONTMATTER_MAX_VALUE,
				),
			}))
		return { frontmatter: rows, markdown }
	} catch {
		return { frontmatter: raw, markdown }
	}
}

/** Project-relative text for `value` when it lies under one of the roots, otherwise undefined. */
function underRoots(roots: readonly string[], value: string): string | undefined {
	const slashed = value.replace(/\\/g, '/')
	if (!slashed.startsWith('/') && !/^[A-Za-z]:\//.test(slashed)) return slashed
	for (const root of roots) {
		const base = root.replace(/\\/g, '/')
		const prefix = base.endsWith('/') ? base : `${base}/`
		if (caseFold(slashed).startsWith(caseFold(prefix))) return slashed.slice(prefix.length)
	}
	return undefined
}

function fileUrlPath(ref: string): string | undefined {
	try {
		const url = new URL(ref)
		if (url.host && url.host !== 'localhost') return undefined
		let path = decodeURIComponent(url.pathname)
		if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
		return path + url.hash
	} catch {
		return undefined
	}
}

async function resolveOne(roots: readonly string[], ref: unknown): Promise<ProjectLinkResolution> {
	const none: ProjectLinkResolution = { ref: typeof ref === 'string' ? ref : '' }
	if (typeof ref !== 'string') return none
	let candidate = ref.trim()
	if (!candidate || candidate.length > 1_000) return none
	if (/^file:/i.test(candidate)) {
		const path = fileUrlPath(candidate)
		if (path === undefined) return none
		candidate = path
	} else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) return none
	const regular = async (path: string): Promise<string | undefined> => {
		const inside = underRoots(roots, path)
		if (inside === undefined) return undefined
		try {
			const confined = await confineProjectPath(roots[0] as string, inside)
			// Hidden files are not readable, so they must not become links either.
			await assertVisible(roots[0] as string, confined.relative)
			return (await stat(confined.absolute)).isFile() ? confined.relative : undefined
		} catch {
			return undefined
		}
	}
	const found = (path: string, line?: string): ProjectLinkResolution => {
		const number = line === undefined ? 0 : Number(line)
		return {
			ref,
			path,
			...(number >= 1 && number <= LINE_MAX ? { line: number } : {}),
		}
	}
	const whole = await regular(candidate)
	if (whole !== undefined) return found(whole)
	let stripped = candidate
	let line: string | undefined
	const hash = /#L(\d+)(?:-L?\d+)?$/.exec(stripped)
	if (hash) {
		stripped = stripped.slice(0, hash.index)
		line = hash[1]
	}
	const colon = /:(\d+)(?::\d+)?$/.exec(stripped)
	if (colon) {
		stripped = stripped.slice(0, colon.index)
		line ??= colon[1]
	}
	if (stripped === candidate) return none
	const path = await regular(stripped)
	return path === undefined ? none : found(path, line)
}

/**
 * Which references in a reply name real files of the project. `roots[0]` is the resolved
 * root; later entries are other spellings of the same folder an absolute path may use.
 */
export async function resolveProjectLinks(
	roots: readonly string[],
	refs: unknown,
): Promise<ProjectLinkResolution[]> {
	if (!Array.isArray(refs)) throw new ProjectPathError('Send a list of references.')
	if (refs.length > LINK_MAX_REFS) throw new ProjectPathError('Too many references at once.')
	const results: ProjectLinkResolution[] = []
	for (const ref of refs) results.push(await resolveOne(roots, ref))
	return results
}
