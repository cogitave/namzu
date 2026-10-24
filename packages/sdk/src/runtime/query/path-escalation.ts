/**
 * What a call writes or removes that no mode may approve in advance.
 *
 * Three questions the kernel answers about a prepared call before it runs, all
 * of them about the call's own arguments and none about the model's intent:
 *
 * - does it write a protected path (a git hook, a shell rc file, editor or
 *   tool configuration, the project's `.namzu` directory)?
 * - does its shell line remove something catastrophic?
 * - does its shell line reach a path outside the turn's roots, through a
 *   command whose operands are paths or through a redirection?
 *
 * The first two are floors: they hold in every mode, the way a sandbox escape
 * does. The third is the existing outside-root boundary, extended from the
 * file tools' one declared argument to the paths a shell line names.
 */

import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isProtectedPath } from '../../authorization/protected-paths.js'
import { dangerousRemoval } from '../../authorization/removal.js'
import type { ShellDialect } from '../../authorization/shell-lexer.js'
import { readShellLine, shellPathAccess } from '../../authorization/shell-paths.js'
import { canonicalize, pathOutsideRoots } from '../../tools/paths.js'

/** What the escalation records carry. */
export interface PathEscalations {
	readonly outsidePaths: readonly string[]
	readonly protectedPaths: readonly string[]
	readonly dangerousRemoval?: string
}

export interface PathEscalationContext {
	/** The working directory first, then the added directories. */
	readonly roots: readonly string[]
	/** Whether to report paths outside the roots (`outsideRootAccess: 'review'`, no sandbox). */
	readonly reviewOutside: boolean
}

/**
 * The part of `absolute` that protected names are looked for in.
 *
 * Inside a root (the working directory or an added directory) that is the part
 * below the root, not the whole path: the root is where the turn was put, and
 * a root that itself sits under a protected name is not a reason to ask about
 * every file in it. The case that matters is the managed worktree a sub-agent
 * runs in, `~/.namzu/projects/<slug>/worktrees/<name>`, which lies under
 * `.namzu` by construction. A path in no root is looked at whole.
 */
function protectedScope(absolute: string, roots: readonly string[]): string {
	let best: string | undefined
	for (const root of roots) {
		const base = resolve(root)
		const below = relative(base, absolute)
		if (below === '' || below.startsWith('..') || isAbsolute(below)) continue
		if (best === undefined || below.length < best.length) best = below
	}
	return best ?? absolute
}

/** A write is protected when its spelling, or the place a link leads to, is. */
async function isProtectedWrite(
	spelled: string,
	absolute: string,
	roots: readonly string[],
): Promise<boolean> {
	if (isProtectedPath(isAbsolute(spelled) ? protectedScope(absolute, roots) : spelled)) return true
	if (isProtectedPath(protectedScope(absolute, roots))) return true
	const real = await canonicalize(absolute)
	const realRoots = await Promise.all(roots.map((root) => canonicalize(resolve(root))))
	return isProtectedPath(protectedScope(real, [...roots, ...realRoots]))
}

/** `{a,b}` with plain comma lists, one level at a time, bounded. */
export function expandBraces(value: string, limit = 16): string[] {
	const open = value.indexOf('{')
	if (open < 0) return [value]
	let depth = 0
	let close = -1
	const commas: number[] = []
	for (let i = open; i < value.length; i += 1) {
		const c = value[i]
		if (c === '{') depth += 1
		else if (c === '}') {
			depth -= 1
			if (depth === 0) {
				close = i
				break
			}
		} else if (c === ',' && depth === 1) commas.push(i)
	}
	if (close < 0 || commas.length === 0) return [value]
	const head = value.slice(0, open)
	const tail = value.slice(close + 1)
	const parts: string[] = []
	let start = open + 1
	for (const comma of [...commas, close]) {
		parts.push(value.slice(start, comma))
		start = comma + 1
	}
	const out: string[] = []
	for (const part of parts) {
		for (const rest of expandBraces(head + part + tail, limit)) {
			out.push(rest)
			if (out.length >= limit) return out
		}
	}
	return out
}

/** The path a use names with `~` and `$HOME` read as the home directory, or why it cannot be. */
function settle(
	value: string,
	home: string,
): { readonly path: string } | { readonly unresolved: true } {
	if (value === '~') return { path: home }
	if (value.startsWith('~/')) return { path: resolve(home, value.slice(2)) }
	if (value.startsWith('~')) return { unresolved: true }
	const variable = /^\$(?:\{HOME\}|HOME)(?=\/|$)/.exec(value)
	if (variable !== null) return { path: resolve(home, `.${value.slice(variable[0].length)}`) }
	if (/[$`]/.test(value)) return { unresolved: true }
	return { path: value }
}

/** The part of a glob path before the first segment that holds a glob character. */
function beforeGlob(path: string): string {
	const at = path.search(/[*?[]/)
	if (at < 0) return path
	const cut = path.lastIndexOf('/', at)
	return cut <= 0 ? '/' : path.slice(0, cut)
}

/** A write the file tool's own declared path argument names. */
export async function declaredWriteEscalation(
	roots: readonly string[],
	value: string,
): Promise<string | undefined> {
	const [first] = roots
	if (first === undefined || value === '') return undefined
	const absolute = resolve(resolve(first), value)
	return (await isProtectedWrite(value, absolute, roots)) ? absolute : undefined
}

/** What a shell line reaches. */
export async function shellEscalations(
	line: string,
	dialect: ShellDialect,
	context: PathEscalationContext,
): Promise<PathEscalations> {
	const reading = readShellLine(line, dialect)
	const access = shellPathAccess(reading)
	const [cwd, ...added] = context.roots
	const outside = new Set<string>()
	const protectedPaths = new Set<string>()
	const home = homedir()
	if (cwd !== undefined) {
		// A link made earlier in this very line leads somewhere that cannot be
		// read before the line runs: `ln -s /etc l && cd l && echo x > passwd`
		// writes /etc/passwd through a name that is inside the roots. Every
		// operand of an `ln` is such a name (the link is the last, but the
		// check does not guess which), and a path at or under one is outside.
		const madeHere = reading.invocations
			.filter((invocation) => invocation.program === 'ln')
			.flatMap((invocation) => invocation.args.map((arg) => arg.value))
			.filter((value) => value !== '' && !value.startsWith('-'))
			.map((value) => resolve(cwd, value))
		for (const use of access.uses) {
			for (const spelled of expandBraces(use.path)) {
				const settled = settle(spelled, home)
				const unresolved = use.unresolved || 'unresolved' in settled
				const base = 'path' in settled ? settled.path : spelled
				// Where a relative path may start from. Usually the directory the
				// line began in; after a literal `cd <relative>` also the directory
				// that moved to. Both are checked, because the `cd` may sit in a
				// subshell or a pipeline and not apply to this command at all: a
				// path is only called inside when it is inside under every reading.
				const starts = [cwd]
				const moved =
					use.directory !== undefined && 'relative' in use.directory
						? resolve(cwd, use.directory.relative)
						: undefined
				if (moved !== undefined) starts.push(moved)
				const absolutes = isAbsolute(base)
					? [resolve(base)]
					: starts.map((from) => resolve(from, base))
				if (use.access === 'write') {
					for (const candidate of absolutes) {
						if (await isProtectedWrite(spelled, candidate, context.roots))
							protectedPaths.add(candidate)
					}
				}
				if (!context.reviewOutside) continue
				if (unresolved) {
					// A write whose target is decided at runtime cannot be checked; a
					// read of one is left alone.
					if (use.access === 'write') outside.add(spelled)
					continue
				}
				if (
					use.directory !== undefined &&
					'unknown' in use.directory &&
					use.access === 'write' &&
					!isAbsolute(base) &&
					!spelled.startsWith('~')
				) {
					// A `cd` earlier in the line, to somewhere the reader cannot name,
					// moves a relative target out of reach of a comparison with the roots.
					outside.add(spelled)
					continue
				}
				for (const candidate of absolutes) {
					if (
						madeHere.some((link) => candidate === link || candidate.startsWith(`${link}${sep}`))
					) {
						outside.add(candidate)
						continue
					}
					const reached = await pathOutsideRoots(context.roots, beforeGlob(candidate))
					if (reached !== undefined) outside.add(reached)
				}
			}
		}
	}
	const removal =
		cwd === undefined
			? undefined
			: dangerousRemoval(reading, access.changesDirectory, {
					cwd,
					additionalDirectories: added,
					home,
				})
	return {
		outsidePaths: [...outside],
		protectedPaths: [...protectedPaths],
		...(removal !== undefined ? { dangerousRemoval: removal } : {}),
	}
}
