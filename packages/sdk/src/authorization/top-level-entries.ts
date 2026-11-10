/**
 * Whether a call creates or deletes a top-level entry of the home folder or of
 * the filesystem root.
 *
 * A session that runs without asking can still leave `~/some-new-folder` or
 * `/some-new-folder` behind, or remove one, and nobody chose that place. This
 * is the same kind of question as a protected write: it is asked of a person
 * in every mode, and refused where nobody can be asked.
 *
 * "Top-level entry" means the first name below the home folder or below `/`.
 * Creating anything below a first name that does not exist yet creates that
 * entry (`mkdir -p ~/new/sub`), so it counts. Anything inside a first name that
 * already exists (`~/projects/x/new`, `/tmp/x`) is not asked about, and neither
 * is changing a top-level entry that is already there.
 *
 * Only what can be read before the line runs is judged: a path built from a
 * variable or a command substitution is left alone rather than prompting on
 * every command, and so is a relative path after a `cd` in the same line.
 */

import { lstatSync } from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

import type { ShellWord } from './shell-lexer.js'
import { type ShellReading, expandsAtRuntime } from './shell-paths.js'

/** Programs that delete the paths they are given. */
const REMOVERS = new Set(['rm', 'rmdir'])

export function entryExists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	} catch {
		return false
	}
}

/**
 * The top-level entry a `via` write to `absolute` would create or delete, or
 * undefined. `via` is the program that names the path (`rm`, `mkdir`,
 * `redirect`, `write`...).
 */
export function topLevelEntryChange(
	absolute: string,
	via: string,
	home: string,
	exists: (path: string) => boolean = entryExists,
): string | undefined {
	if (/[*?[]/.test(absolute)) return undefined
	const target = resolve(absolute)
	const removes = REMOVERS.has(via)
	for (const base of new Set([resolve(home), parse(target).root])) {
		const below = relative(base, target)
		if (below === '' || below.startsWith('..') || isAbsolute(below)) continue
		const first = below.split(sep)[0] as string
		const entry = join(base, first)
		if (removes) {
			if (target === entry && exists(entry)) return entry
		} else if (!exists(entry)) return entry
	}
	return undefined
}

/** A word written as `~`, `~/x` or `$HOME/x`, or any other path, as an absolute path; undefined when it cannot be read. */
function literal(word: ShellWord, home: string, cwd: string | undefined): string | undefined {
	if (expandsAtRuntime(word)) return undefined
	const value = word.value
	if (value === '~') return home
	if (value.startsWith('~/')) return resolve(home, value.slice(2))
	if (value.startsWith('~') || /[$`]/.test(value)) return undefined
	if (isAbsolute(value)) return resolve(value)
	return cwd === undefined ? undefined : resolve(cwd, value)
}

/** The positional words of an argument list: flags and `--` dropped. */
function positionals(args: readonly ShellWord[]): ShellWord[] {
	const out: ShellWord[] = []
	let literalRest = false
	for (const arg of args) {
		if (!literalRest && arg.value === '--') {
			literalRest = true
			continue
		}
		if (!literalRest && arg.value.startsWith('-') && arg.value !== '-') continue
		out.push(arg)
	}
	return out
}

/** `git clone` options that take the next word as their value. */
const CLONE_VALUED = new Set([
	'-b',
	'--branch',
	'-o',
	'--origin',
	'-c',
	'--config',
	'--depth',
	'--reference',
	'--reference-if-able',
	'--separate-git-dir',
	'--template',
	'-j',
	'--jobs',
	'--filter',
	'--server-option',
	'-u',
	'--upload-pack',
	'--shallow-since',
	'--shallow-exclude',
	'--bundle-uri',
	'--ref-format',
])

/** The directory a `git clone` will create, or undefined when it is not a clone or cannot be read. */
function cloneDestination(
	args: readonly ShellWord[],
	home: string,
	cwd: string | undefined,
): string | undefined {
	let index = 0
	let base = cwd
	while (index < args.length && (args[index] as ShellWord).value.startsWith('-')) {
		const flag = (args[index] as ShellWord).value
		index += 1
		if ((flag === '-C' || flag === '-c') && index < args.length) {
			if (flag === '-C') {
				const moved = literal(args[index] as ShellWord, home, base)
				if (moved === undefined) return undefined
				base = moved
			}
			index += 1
		}
	}
	if (args[index]?.value !== 'clone') return undefined
	const operands: ShellWord[] = []
	for (let i = index + 1; i < args.length; i += 1) {
		const word = args[i] as ShellWord
		if (word.value === '--') {
			operands.push(...args.slice(i + 1))
			break
		}
		if (word.value.startsWith('-')) {
			if (CLONE_VALUED.has(word.value)) i += 1
			continue
		}
		operands.push(word)
	}
	const [source, explicit] = operands
	if (source === undefined) return undefined
	if (explicit !== undefined) return literal(explicit, home, base)
	if (expandsAtRuntime(source) || base === undefined) return undefined
	const name = source.value
		.replace(/[/\\]+$/, '')
		.replace(/\.git$/, '')
		.split(/[/\\:]/)
		.pop()
	return name ? resolve(base, name) : undefined
}

/**
 * Top-level entries a `git clone` or a `mv` in the line creates or removes.
 * Relative paths are read from `cwd` only when no `cd` is in the line.
 */
export function topLevelEntriesOfMovers(
	reading: ShellReading,
	options: {
		readonly home: string
		readonly cwd: string | undefined
		readonly changesDirectory: boolean
		readonly exists?: (path: string) => boolean
	},
): string[] {
	const cwd = options.changesDirectory ? undefined : options.cwd
	const found = new Set<string>()
	for (const { program, args } of reading.invocations) {
		if (program === 'git') {
			const dest = cloneDestination(args, options.home, cwd)
			if (dest !== undefined) {
				const hit = topLevelEntryChange(dest, 'git', options.home, options.exists)
				if (hit !== undefined) found.add(hit)
			}
		} else if (program === 'mv') {
			const words = positionals(args)
			// `-t DIR` and `-T` change which word is the destination; left alone.
			if (args.some((a) => a.value === '-t' || a.value.startsWith('--target-directory'))) continue
			const paths = words.map((w) => literal(w, options.home, cwd))
			const sources = paths.slice(0, -1)
			for (const source of sources) {
				if (source === undefined) continue
				const hit = topLevelEntryChange(source, 'rm', options.home, options.exists)
				if (hit !== undefined) found.add(hit)
			}
			const dest = paths[paths.length - 1]
			if (dest !== undefined && words.length >= 2) {
				const hit = topLevelEntryChange(dest, 'mv', options.home, options.exists)
				if (hit !== undefined) found.add(hit)
			}
		}
	}
	return [...found]
}
