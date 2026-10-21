import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'

import ignore, { type Ignore } from 'ignore'

import { readRegular, toRel } from './fsafe.js'
import { abortError } from './host.js'
import { DEFAULT_IGNORED_DIRS, type IndexOptions } from './indexer.js'
import { isDeclarationFile, languageOf } from './parse.js'

/** A file the walk found that is worth parsing. */
export interface Candidate {
	readonly rel: string
	readonly abs: string
}

/**
 * One thing the walk saw and did not index, by the directory it was in.
 *
 * - `dir`: a directory whose NAME is in the ignore list.
 * - `git`: a directory or source file a `.gitignore` excludes.
 * - `ext`: a file with an extension that holds code but is not parsed.
 * - `dts`: a declaration file.
 */
export interface Excluded {
	readonly path: string
	readonly kind: 'dir' | 'git' | 'ext' | 'dts'
	readonly name: string
	readonly n: number
}

/** The limits a call can stop at. */
export type Limit = 'time' | 'dirs' | 'files'

export interface Walk {
	readonly files: Candidate[]
	/** Directories visited, with their mtime, for the new-file check. */
	readonly dirs: Array<{ rel: string; mtimeMs: number }>
	/** The limits the walk itself stopped at; its listing is then incomplete. */
	readonly limits: Set<Limit>
	readonly excluded: Excluded[]
	/**
	 * With `known` given: the known child directories of the start that are no
	 * longer there (or are now ignored), whose rows must go.
	 */
	readonly vanished: string[]
}

/**
 * Extensions of files that hold code in languages this index does not parse:
 * a `.html` page with an inline script, a `.vue` or `.svelte` component, a
 * module under another JavaScript spelling. A query about a string in one of
 * them finds nothing, which is only an honest answer if it says so.
 */
export const UNINDEXED_CODE_EXTENSIONS: ReadonlySet<string> = new Set([
	'.es',
	'.es5',
	'.es6',
	'.jsm',
	'.html',
	'.htm',
	'.vue',
	'.svelte',
	'.astro',
	'.coffee',
])

/** Of those, the ones likely to hold JavaScript: a search that skips one is not complete. */
export const MAY_HOLD_JS: ReadonlySet<string> = UNINDEXED_CODE_EXTENSIONS

/**
 * Default-ignored names that are only build output when they sit beside a
 * `package.json` (or a `.gitignore` lists them): `src/build/` in a project is
 * source, and ignoring it by name would hide it.
 */
const BUILD_OUTPUT_NAMES: ReadonlySet<string> = new Set(['dist', 'build', 'out'])

function isDefaultList(list: readonly string[]): boolean {
	return (
		list.length === DEFAULT_IGNORED_DIRS.length &&
		list.every((n, i) => n === DEFAULT_IGNORED_DIRS[i])
	)
}

/** Directories whose absence from an answer never matters: not the project's own code. */
export const NEVER_SOURCE_DIRS: ReadonlySet<string> = new Set([
	'node_modules',
	'.git',
	'.hg',
	'.svn',
	'.namzu',
])

/** How much of a script's start is read to find its `#!` line. */
const SHEBANG_BYTES = 256
/** A `.gitignore` larger than this is ignored, not parsed. */
const MAX_GITIGNORE_BYTES = 1024 * 1024
/** A `.gitignore` line longer than this is not a path anyone wrote. */
const MAX_PATTERN_CHARS = 4096
/** Past this many lines a `.gitignore` is not checked line by line. */
const MAX_CHECKED_LINES = 5000
/** How long synchronous work may run before the event loop gets a turn. */
const SLICE_MS = 20

const NODE_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:node|nodejs|bun|deno)(?:\s|$)/

/** Whether `head` (a file's first bytes) starts a Node, Bun or Deno script. */
export function hasNodeShebang(head: Uint8Array): boolean {
	if (head.length < 3 || head[0] !== 0x23 || head[1] !== 0x21) return false
	const text = Buffer.from(head).toString('latin1')
	const line = text.split(/\r?\n/, 1)[0] ?? ''
	return NODE_SHEBANG.test(line)
}

/** A name with no extension at all: where a script with a shebang can hide. */
export function isExtensionless(name: string): boolean {
	return !name.slice(1).includes('.')
}

export async function shebangOf(root: string, abs: string): Promise<boolean> {
	const read = await readRegular(root, abs, SHEBANG_BYTES)
	return read.ok && hasNodeShebang(read.buffer)
}

/** The `.gitignore` rules in force at one directory. Shallow first; the deepest decisive rule wins. */
interface Rules {
	readonly base: string
	readonly ig: Ignore
}

async function loadGitignore(root: string, abs: string, base: string): Promise<Rules | undefined> {
	const read = await readRegular(root, join(abs, '.gitignore'))
	if (!read.ok || read.buffer.length > MAX_GITIGNORE_BYTES) return undefined
	const text = read.buffer.toString('utf8')
	// `ignore` compiles a rule to a regular expression when it is first tested,
	// and a rule that cannot be compiled (too large, malformed) throws there, in
	// the middle of a query. Each line is tested once, alone, here; the ones that
	// throw are dropped and the rest are kept.
	const lines = text.split(/\r?\n/)
	try {
		if (lines.length > MAX_CHECKED_LINES) return { base, ig: ignore().add(text) }
		const kept = lines.filter((line) => {
			if (line.length > MAX_PATTERN_CHARS) return false
			try {
				const probe = ignore().add(line)
				probe.test('probe/path.js')
				probe.test('probe/dir/')
				return true
			} catch {
				return false
			}
		})
		return { base, ig: ignore().add(kept.join('\n')) }
	} catch {
		return undefined
	}
}

function gitIgnored(rules: readonly Rules[], rel: string, isDir: boolean): boolean {
	let ignored = false
	for (const { base, ig } of rules) {
		const within =
			base === '' ? rel : rel.startsWith(`${base}/`) ? rel.slice(base.length + 1) : undefined
		if (within === undefined || within === '') continue
		let verdict: { ignored: boolean; unignored: boolean }
		try {
			verdict = ig.test(isDir ? `${within}/` : within)
		} catch {
			// A rule in an oversized file that cannot be compiled: this file's rules
			// do not apply, rather than the whole query failing.
			continue
		}
		if (verdict.unignored) ignored = false
		else if (verdict.ignored) ignored = true
	}
	return ignored
}

function ancestors(rel: string): string[] {
	if (rel === '') return ['']
	const parts = rel.split('/')
	const out = ['']
	for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
	return out
}

export interface WalkBudget {
	readonly started: number
	readonly options: IndexOptions
	readonly signal: AbortSignal | undefined
}

/**
 * Source files at or under `start`, as POSIX-separated relative paths, in a
 * stable order, and everything the walk saw and left out. A file `start` is a
 * walk of one.
 *
 * Left out is recorded, not just skipped: what an index never looked at is
 * part of what an answer from it can claim.
 */
export async function collect(
	root: string,
	start: string,
	b: WalkBudget,
	skip: (reason: string) => void,
	known?: ReadonlySet<string>,
): Promise<Walk> {
	const walk: Walk = { files: [], dirs: [], limits: new Set(), excluded: [], vanished: [] }
	const ignored = new Set(b.options.ignoreDirs)
	// `dist`, `build` and `out` are build output by default only beside a
	// package.json; a list the caller wrote is taken as written.
	const conditional = isDefaultList(b.options.ignoreDirs)
	const useGit = b.options.respectGitignore !== false
	const abortIfAsked = (): void => {
		if (b.signal?.aborted) throw abortError()
	}
	let first: Stats
	try {
		first = await lstat(start)
	} catch {
		return walk
	}
	const startRel = toRel(root, start) ?? ''
	if (first.isSymbolicLink()) {
		skip('symbolic link')
		return walk
	}
	if (first.isFile()) {
		if (languageOf(start) !== undefined) {
			if (!isDeclarationFile(start)) walk.files.push({ rel: startRel, abs: start })
		} else if (isExtensionless(basename(start)) && (await shebangOf(root, start))) {
			walk.files.push({ rel: startRel, abs: start })
		}
		return walk
	}
	if (!first.isDirectory()) return walk

	// Rules from the root down to the start directory apply to everything below it.
	const inherited: Rules[] = []
	if (useGit) {
		for (const dir of ancestors(startRel)) {
			if (dir === startRel) break
			const rules = await loadGitignore(
				root,
				dir === '' ? root : join(root, ...dir.split('/')),
				dir,
			)
			if (rules) inherited.push(rules)
		}
	}

	// Naming a path that a rule above it ignores is a request to look inside it:
	// those rules no longer apply, or `index` of a `.gitignore`d `dist` would
	// walk it and find every file ignored.
	if (inherited.length > 0 && gitIgnored(inherited, startRel, true)) inherited.length = 0

	interface Pending {
		readonly abs: string
		readonly rel: string
		readonly rules: readonly Rules[]
	}
	const pending: Pending[] = [{ abs: start, rel: startRel, rules: inherited }]
	let lastYield = performance.now()
	let visited = 0
	const tally = new Map<string, Excluded>()
	const note = (path: string, kind: Excluded['kind'], name: string): void => {
		const key = `${path}\0${kind}\0${name}`
		const row = tally.get(key)
		tally.set(key, { path, kind, name, n: (row?.n ?? 0) + 1 })
	}
	while (pending.length > 0) {
		abortIfAsked()
		if (visited >= b.options.maxDirectories) {
			walk.limits.add('dirs')
			break
		}
		if (performance.now() - b.started > b.options.maxMillis) {
			walk.limits.add('time')
			break
		}
		const dir = pending.pop() as Pending
		visited++
		let entries: Dirent[]
		try {
			// The mtime is taken BEFORE the listing: an entry created between the two
			// moves it past the recorded value, so the next check sees the change. Taken
			// after, that entry would be missing from the listing and covered by the stamp.
			const mtimeMs = (await lstat(dir.abs)).mtimeMs
			entries = await readdir(dir.abs, { withFileTypes: true })
			walk.dirs.push({ rel: dir.rel, mtimeMs })
		} catch {
			skip('unreadable directory')
			continue
		}
		entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))
		let rules = dir.rules
		if (useGit && entries.some((e) => e.name === '.gitignore' && e.isFile())) {
			const own = await loadGitignore(root, dir.abs, dir.rel)
			if (own) rules = [...rules, own]
		}
		const subdirs: Pending[] = []
		const hasPackageJson = entries.some((e) => e.name === 'package.json' && e.isFile())
		const kept = new Set<string>()
		for (const entry of entries) {
			const rel = dir.rel === '' ? entry.name : `${dir.rel}/${entry.name}`
			if (entry.isSymbolicLink()) {
				// A link can point anywhere, including out of the root. Never followed.
				if (languageOf(entry.name) !== undefined) skip('symbolic link')
				continue
			}
			if (entry.isDirectory()) {
				const byName =
					ignored.has(entry.name) &&
					!(conditional && BUILD_OUTPUT_NAMES.has(entry.name) && !hasPackageJson)
				if (byName) note(dir.rel, 'dir', entry.name)
				else if (rules.length > 0 && gitIgnored(rules, rel, true))
					note(dir.rel, 'git', `${entry.name}/`)
				else if (known?.has(rel) && dir.rel === startRel) kept.add(rel)
				else subdirs.push({ abs: join(dir.abs, entry.name), rel, rules })
				continue
			}
			if (!entry.isFile()) continue
			const abs = join(dir.abs, entry.name)
			const lang = languageOf(entry.name)
			if (lang === undefined) {
				const ext = extname(entry.name).toLowerCase()
				if (UNINDEXED_CODE_EXTENSIONS.has(ext)) {
					note(dir.rel, 'ext', ext)
				} else if (isExtensionless(entry.name) && (await shebangOf(root, abs))) {
					if (rules.length > 0 && gitIgnored(rules, rel, false)) note(dir.rel, 'git', entry.name)
					else if (walk.files.length >= b.options.maxFiles) {
						walk.limits.add('files')
						break
					} else walk.files.push({ rel, abs })
				}
				continue
			}
			if (isDeclarationFile(entry.name)) {
				skip('declaration file')
				note(dir.rel, 'dts', '')
				continue
			}
			if (rules.length > 0 && gitIgnored(rules, rel, false)) {
				note(dir.rel, 'git', entry.name)
				continue
			}
			if (walk.files.length >= b.options.maxFiles) {
				walk.limits.add('files')
				break
			}
			walk.files.push({ rel, abs })
		}
		for (let i = subdirs.length - 1; i >= 0; i--) pending.push(subdirs[i] as Pending)
		if (known && dir.rel === startRel) {
			for (const k of known) if (!kept.has(k)) walk.vanished.push(k)
		}
		if (walk.limits.has('files')) break
		if (performance.now() - lastYield > SLICE_MS) {
			await nextTurn()
			lastYield = performance.now()
		}
	}
	walk.files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
	walk.excluded.push(...tally.values())
	return walk
}
