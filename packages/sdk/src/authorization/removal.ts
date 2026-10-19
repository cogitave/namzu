/**
 * Whether a command line removes something it must not, decided from its
 * targets.
 *
 * The old floor was one regular expression, `rm\s+-rf\s+\/`. It matched a
 * single spelling: `rm -fr /`, `rm -r -f /`, `rm --recursive --force /`,
 * `rm -rf ~`, `rm -rf $HOME`, `rm -rf "$BUILD/"` (empty variable, so `/`) and
 * `rm -rf ..` all went past it. The flags were never the point. A removal is
 * catastrophic because of WHAT it removes, so this reads the targets of `rm`
 * and `rmdir` whatever the flags, as the reference terminal's dangerous-removal
 * check does (version 2.1.302).
 *
 * A removal is flagged when a target is
 *
 * - the file system root, a top-level directory (`/usr`, `/etc`), or the
 *   operator's home directory (`~`, `$HOME`, `${HOME}`);
 * - the working directory or any directory above it (`.`, `..`, `../..`), or
 *   the same for an added directory when the target is a glob;
 * - a bare glob that crosses directories (`*`, `/*`, `*\/*`);
 * - a variable followed by a slash (`$DIR/`, `"$DIR/"/*`): when the variable
 *   is empty the path is `/`; or a variable followed by a top-level directory
 *   name (`$PREFIX/usr`) when the variable may be unset;
 * - the output of a command substitution, for a recursive removal;
 * - a path that cannot be settled before the line runs (a relative glob after
 *   a `cd`, `a/../*`, `~user`).
 *
 * The answer is a reason, which the kernel turns into an escalation: asked
 * every time, in every mode, and refused when nobody can be asked. It is not a
 * denial: the reference asks, because there are legitimate removals a person
 * can approve.
 */

import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	basename as pathBasename,
	resolve,
	sep,
} from 'node:path'

import type { ShellWord } from './shell-lexer.js'
import { type ShellInvocation, type ShellReading, expandsAtRuntime } from './shell-paths.js'

/** What the check needs to know about the turn. */
export interface RemovalContext {
	/** The turn's working directory. */
	readonly cwd: string
	/** Directories added to the session. */
	readonly additionalDirectories?: readonly string[]
	/** The operator's home directory; the host's own when omitted. */
	readonly home?: string
	/** Environment to decide whether a variable may be empty; `process.env` when omitted. */
	readonly env?: Readonly<Record<string, string | undefined>>
}

/** Top-level directories a variable-prefixed target may become when the variable is empty. */
const TOP_LEVEL =
	'bin|boot|dev|etc|home|lib|lib32|lib64|libx32|media|mnt|opt|proc|root|run|sbin|srv|sys|tmp|usr|var|snap|nix|lost\\+found|private|cores|Applications|Library|System|Users|Volumes|Windows|ProgramData|cygdrive'

const VAR = '(?:\\{([A-Za-z_][A-Za-z0-9_]*)(?::?-[^}]*)?\\}|([A-Za-z_][A-Za-z0-9_]*))'
/** `$VAR/` followed by something that cannot name a child: end, a glob, another expansion, a slash. */
const EMPTY_VARIABLE_ROOT = new RegExp(`^\\$${VAR}/(?:[*?[{]|\\$|/|$)`)
const EMPTY_VARIABLE_TOP = new RegExp(`^\\$${VAR}/(${TOP_LEVEL})(?:/+\\*+)*/?$`, 'i')
const BARE_HOME = /^\$(?:\{HOME\}|HOME)(?:\/+\*?)?$/

function fold(name: string): string {
	return name.toLowerCase().replace(/ı/g, 'i').replace(/ſ/g, 's')
}

/** `realpath` of the deepest existing ancestor, with the rest appended. */
function canonical(path: string): string {
	let existing = path
	let rest = ''
	for (;;) {
		if (existsSync(existing)) {
			try {
				const real = realpathSync(existing)
				return rest === '' ? real : join(real, rest)
			} catch {
				return path
			}
		}
		const parent = dirname(existing)
		if (parent === existing) return path
		rest = rest === '' ? pathBasename(existing) : join(pathBasename(existing), rest)
		existing = parent
	}
}

function slashes(path: string): string {
	return path.replace(/[\\/]+/g, '/')
}

function isWithinOrEqual(parent: string, child: string): boolean {
	const p = fold(slashes(parent)).replace(/\/$/, '')
	const c = fold(slashes(child)).replace(/\/$/, '')
	return c === p || c.startsWith(`${p}/`) || p === ''
}

/** The file system root, a top-level directory, a drive root, a bare glob, or the home directory. */
function isCritical(path: string, homes: readonly string[]): boolean {
	const normalized = slashes(path)
	if (normalized === '*' || normalized.endsWith('/*')) return true
	const trimmed = normalized === '/' ? '/' : normalized.replace(/\/$/, '')
	if (trimmed === '/') return true
	if (/^[A-Za-z]:\/?$/.test(trimmed)) return true
	if (homes.some((home) => fold(trimmed) === fold(slashes(home).replace(/\/$/, '')))) return true
	if (dirname(trimmed) === '/') return true
	return /^[A-Za-z]:\/[^/]+$/.test(trimmed)
}

function isRecursive(args: readonly ShellWord[]): boolean {
	const flags: string[] = []
	for (const arg of args) {
		if (arg.value === '--') break
		flags.push(arg.value)
	}
	return flags.some((flag) => /^--r/.test(flag) || /^-[a-zA-Z]*[rR]/.test(flag))
}

/** Operands of `rm`/`rmdir`: everything after `--` and everything from the first non-flag on. */
function targetsOf(args: readonly ShellWord[]): ShellWord[] {
	const out: ShellWord[] = []
	let afterDashes = false
	let started = false
	for (const arg of args) {
		if (afterDashes || started) out.push(arg)
		else if (arg.value === '--') afterDashes = true
		else if (arg.value === '-' || !arg.value.startsWith('-')) {
			out.push(arg)
			started = true
		}
	}
	return out
}

/** `~` and `~/…` against `home`. */
function expandTilde(value: string, home: string): string {
	if (value === '~') return home
	if (value.startsWith('~/')) return join(home, value.slice(2))
	return value
}

/**
 * Why the line removes something it must not, or `undefined`.
 *
 * `reading` is {@link readShellLine}'s result for the same line;
 * `changesDirectory` says a `cd` runs in it, after which a relative target is
 * not the one the working directory names.
 */
export function dangerousRemoval(
	reading: ShellReading,
	changesDirectory: boolean,
	context: RemovalContext,
): string | undefined {
	const removals = reading.invocations.filter((i) => i.program === 'rm' || i.program === 'rmdir')
	if (removals.length === 0) return undefined
	const home = context.home ?? homedir()
	const env = context.env ?? process.env
	const cwd = resolve(context.cwd)
	const homes = [home, canonical(home)]
	const workdirs = [cwd, canonical(cwd)]
	const everyDirectory = [
		...new Set([
			...workdirs,
			...(context.additionalDirectories ?? []).flatMap((d) => [resolve(d), canonical(resolve(d))]),
		]),
	]
	for (const removal of removals) {
		const reason = checkRemoval(removal, {
			cwd,
			home,
			homes,
			workdirs,
			everyDirectory,
			env,
			changesDirectory,
		})
		if (reason !== undefined) return reason
	}
	return undefined
}

interface Scope {
	readonly cwd: string
	readonly home: string
	readonly homes: readonly string[]
	readonly workdirs: readonly string[]
	readonly everyDirectory: readonly string[]
	readonly env: Readonly<Record<string, string | undefined>>
	readonly changesDirectory: boolean
}

function checkRemoval(removal: ShellInvocation, scope: Scope): string | undefined {
	const { program, args } = removal
	const recursive = isRecursive(args)
	for (const target of targetsOf(args)) {
		const spelled = target.value
		if (spelled === '') continue

		// A backslash alone is the drive root in Git Bash on Windows.
		if (/^\\+$/.test(spelled)) return `${program} ${spelled}: a backslash alone is the drive root`

		if (BARE_HOME.test(spelled)) return `${program} ${spelled}: that is the home directory`

		const root = EMPTY_VARIABLE_ROOT.exec(spelled)
		if (root !== null) {
			const name = root[1] ?? root[2]
			return `${program} ${spelled}: when $${name} is empty this removes /`
		}
		const top = EMPTY_VARIABLE_TOP.exec(spelled)
		if (top !== null) {
			const name = top[1] ?? top[2] ?? ''
			const value = scope.env[name]
			if (typeof value !== 'string' || value === '') {
				return `${program} ${spelled}: when $${name} is empty this removes /${top[3]}`
			}
		}

		if (target.substitutes && recursive && /^(?:\$\(.*\)|`.*`)[/*.]*$/s.test(spelled)) {
			return `${program} ${spelled}: the target is the output of a command substitution, which cannot be checked before it runs`
		}
		// A substitution that comes out empty leaves what is before it.
		const stripped = target.substitutes
			? spelled.replace(/(.)(?:\$\([^)]*\)|`[^`]*`)(?:(?!\.\.)[/*.])*((?:\/\.\.)*)\/*$/s, '$1$2')
			: spelled
		const reason = checkTarget(program, args, stripped, target, scope)
		if (reason !== undefined) return reason
	}
	return undefined
}

function checkTarget(
	program: string,
	args: readonly ShellWord[],
	spelled: string,
	word: ShellWord,
	scope: Scope,
): string | undefined {
	const expanded = expandTilde(spelled, scope.home)
	const relative = !isAbsolute(expanded)
	if (expandsAtRuntime(word) && /[$`]/.test(expanded)) {
		// A variable the check cannot read: the reference treats it as a relative
		// name, which is also what the shell does when the variable is unset and
		// the rest is a plain name. Nothing more to learn from it.
		return undefined
	}
	const absolute = relative ? resolve(scope.cwd, expanded) : resolve(expanded)
	let settled = absolute
	for (let previous = ''; previous !== settled; ) {
		previous = settled
		const stripped = settled.replace(/([\\/]\*+)+[\\/]*$/, '') || sep
		if (stripped !== settled) settled = /[\\/]/.test(stripped) ? normalize(stripped) : stripped
	}
	// A glob suffix was stripped from the target: the removal reaches what is in it.
	const globbed = settled !== absolute
	const original = expanded

	if (scope.changesDirectory && globbed && relative && /[\\/]\*$/.test(absolute)) {
		return `${program} ${spelled}: a relative glob after a cd cannot be resolved before the line runs`
	}

	// Where the target sits under the working directory, for the glob depth below.
	let below = settled
	if (relative) {
		const prefix = scope.cwd.endsWith(sep) ? scope.cwd : scope.cwd + sep
		if (settled.startsWith(prefix)) below = settled.slice(prefix.length)
		else if (settled === scope.cwd) below = ''
	}

	if (
		globbed &&
		(hasParentAfterName(original) ||
			original.startsWith('~') ||
			/^[\\/]{2}/.test(original) ||
			(relative && /(^|[\\/])\.\.([\\/]|$)/.test(original) && /[\\/]\*$/.test(absolute)) ||
			(program === 'rmdir' &&
				/[\\/]\*$/.test(absolute) &&
				args.some((a) => /^--p/.test(a.value) || /^-[a-z]*p/.test(a.value))) ||
			(relative && /\*[\\/]+$/.test(original) && /[\\/]\*$/.test(absolute)))
	) {
		return `${program} ${spelled}: the target cannot be resolved to a directory before the line runs`
	}

	if (!globbed || !/[*?[]/.test(below)) {
		const candidates = [settled]
		const real = canonical(settled)
		if (real !== settled) candidates.push(real)
		for (const candidate of candidates) {
			if (isCritical(candidate, scope.homes)) {
				return `${program} ${spelled}: that is the file system root, a top-level directory or the home directory`
			}
			const directories = globbed ? scope.everyDirectory : scope.workdirs
			if (directories.some((directory) => isWithinOrEqual(candidate, directory))) {
				return `${program} ${spelled}: that is the working directory or one of its parents`
			}
		}
	}

	if (globbed && /[\\/]\*$/.test(absolute)) {
		const segments = (value: string): number =>
			value.split(/[\\/]+/).filter((s) => s !== '' && s !== '.').length
		const crossed = segments(absolute) - segments(settled)
		const inside = below.split(/[\\/]+/).filter((s) => /[*?[]/.test(s)).length
		if (crossed + inside > 1) {
			return `${program} ${spelled}: the glob crosses directories that cannot be listed before the line runs`
		}
	}
	return undefined
}

/** `a/../b`: a parent step after a real name, which moves the target somewhere the spelling hides. */
function hasParentAfterName(path: string): boolean {
	let named = false
	for (const segment of path.split(/[\\/]+/)) {
		if (segment === '' || segment === '.') continue
		if (segment === '..') {
			if (named) return true
		} else named = true
	}
	return false
}
