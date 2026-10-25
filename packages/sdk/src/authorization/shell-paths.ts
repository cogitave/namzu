/**
 * The files a shell command line names, read before it runs.
 *
 * The file tools declare a `pathArgument`, so the kernel can see which path a
 * call reaches. A shell command line has no such argument: `cat /etc/passwd`
 * and `echo x > ~/.profile` carry their paths inside one string, and a
 * boundary that only reads declared arguments let both through.
 *
 * This reads the paths a shell line touches: a table of the commands whose
 * positional arguments are paths, with an extractor for each command, the kind
 * of access each makes (read, write or create), and the output redirections of
 * the line. It is a
 * reading of the text, not a model of the shell:
 *
 * - a word that expands at runtime (`$VAR`, `$(...)`) has no path to read;
 *   it is reported with `unresolved` so the caller decides what an unreadable
 *   write target is worth;
 * - a `cd` earlier in the line moves every relative path after it, which the
 *   reading does not follow, so the caller is told one happened;
 * - a command that is not in the table contributes nothing.
 *
 * Nothing here touches the file system. The caller resolves the paths
 * against the turn's roots and decides what is outside them or protected.
 */

import { unwrapReexecChain } from './reexec-wrapper.js'
import {
	type ShellDialect,
	type ShellRedirection,
	type ShellWord,
	basename,
	lexShellCommandLine,
} from './shell-lexer.js'

/** One program invocation found in a line, wrappers unwrapped. */
export interface ShellInvocation {
	/** The program's base name (`/bin/rm` reads as `rm`). */
	readonly program: string
	/** Its arguments, as the shell passes them. */
	readonly args: readonly ShellWord[]
	/** The redirections written on this command itself, when the lexer attached them. */
	readonly redirections?: readonly ShellRedirection[]
}

/** What the lexer found, in the shape this module and the removal check share. */
export interface ShellReading {
	readonly invocations: readonly ShellInvocation[]
	readonly redirections: readonly ShellRedirection[]
	/** False when the line does not parse to the end. */
	readonly complete: boolean
}

const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])

function invocationOf(
	words: readonly ShellWord[],
	redirections?: readonly ShellRedirection[],
): ShellInvocation | undefined {
	if (words.length === 0) return undefined
	const step = unwrapReexecChain(words)
	if (!('rest' in step)) return undefined
	const [head, ...args] = step.rest
	if (head === undefined || head.expands) return undefined
	return {
		program: basename(head.value),
		args,
		...(redirections !== undefined ? { redirections } : {}),
	}
}

/** Every program a line runs, and every redirection it carries. */
export function readShellLine(line: string, dialect: ShellDialect): ShellReading {
	const lexed = lexShellCommandLine(line, { dialect })
	const invocations: ShellInvocation[] = []
	for (const command of lexed.commands) {
		const own = invocationOf(command.words.slice(command.assignments), command.redirections)
		if (own === undefined) continue
		invocations.push(own)
		if (own.program !== 'find') continue
		// `find … -exec CMD … ;` runs CMD on each match; its arguments up to the
		// terminator are CMD's.
		for (let i = 0; i < own.args.length; i += 1) {
			const flag = own.args[i] as ShellWord
			if (flag.expands || !EXEC_FLAGS.has(flag.value)) continue
			const clause: ShellWord[] = []
			for (let j = i + 1; j < own.args.length; j += 1) {
				const word = own.args[j] as ShellWord
				if (!word.expands && (word.value === ';' || word.value === '+')) break
				clause.push(word)
			}
			const nested = invocationOf(clause)
			if (nested !== undefined) invocations.push(nested)
		}
	}
	return {
		invocations,
		redirections: lexed.redirections,
		complete: lexed.complete,
	}
}

/** The kind of access a command makes to a path argument. */
export type PathAccess = 'read' | 'write'

/** A path a line names, as written. */
export interface ShellPathUse {
	/** The path with quotes removed; `~` and `$HOME` are left for the caller. */
	readonly path: string
	readonly access: PathAccess
	/** Which program or redirection named it. */
	readonly via: string
	/** True when the word is decided at runtime and `path` is not what it will be. */
	readonly unresolved: boolean
	/**
	 * Where a relative `path` starts from, when an earlier `cd` in the line moved
	 * the shell. Absent: the directory the line began in. Only a `cd` to one
	 * literal relative directory is followed; anything else is `unknown`.
	 */
	readonly directory?: ShellDirectory
}

/** Where a `cd` earlier in the line left the shell, relative to where the line began. */
export type ShellDirectory =
	| { readonly relative: string }
	/** A `cd` to a runtime-decided, absolute, `~` or `-` target, or a `pushd`/`popd`/`chdir`. */
	| { readonly unknown: true }

export interface ShellPathAccess {
	readonly uses: readonly ShellPathUse[]
	/** A `cd`, `pushd`, `popd` or `chdir` runs somewhere in the line. */
	readonly changesDirectory: boolean
}

/** Devices a command may name without it being a file. */
const HARMLESS_TARGETS = new Set([
	'/dev/null',
	'/dev/stdin',
	'/dev/stdout',
	'/dev/stderr',
	'/dev/tty',
])

function isHarmlessTarget(path: string): boolean {
	return (
		HARMLESS_TARGETS.has(path) ||
		/^\/dev\/fd\/\d+$/.test(path) ||
		/^\/proc\/self\/fd\/[0-2]$/.test(path)
	)
}

/** Whether a word's value still holds an expansion the shell will perform. */
export function expandsAtRuntime(word: ShellWord): boolean {
	return word.expands && (/[$`]/.test(word.value) || word.substitutes)
}

type Args = readonly ShellWord[]

/** Arguments that are not flags: everything after `--`, and everything from the first operand on. */
function operands(args: Args): ShellWord[] {
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

/** `value` as a word that keeps whether `from` will still be expanded by the shell. */
function derived(from: ShellWord, value: string): ShellWord {
	return { ...from, text: value, value }
}

/**
 * Operands of `cp` and `mv`. GNU lets a flag follow an operand, and the
 * destination can be a flag's value: `--target-directory=D`, `--target-directory D`,
 * `-tD`, `-t D`, also inside a cluster (`-at D`, `-rtD`). Reading the operands
 * alone would miss the attached and the trailing forms.
 */
function copyOperands(args: Args): ShellWord[] {
	const out: ShellWord[] = []
	let afterDashes = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		const text = arg.value
		if (afterDashes || text === '-' || !text.startsWith('-')) {
			out.push(arg)
			continue
		}
		if (text === '--') {
			afterDashes = true
			continue
		}
		if (text.startsWith('--')) {
			const eq = text.indexOf('=')
			const name = eq >= 0 ? text.slice(0, eq) : text
			if (name === '--target-directory') {
				if (eq >= 0) out.push(derived(arg, text.slice(eq + 1)))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
			} else if (name === '--suffix' && eq < 0) i += 1
			continue
		}
		for (let j = 1; j < text.length; j += 1) {
			const letter = text[j] as string
			if (letter !== 't' && letter !== 'S') continue
			const rest = text.slice(j + 1)
			if (letter === 't') {
				if (rest !== '') out.push(derived(arg, rest))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
			} else if (rest === '') i += 1
			break
		}
	}
	return out
}

/**
 * The files `touch` reads: `--reference=F`, `--reference F`, `-rF`, `-r F`
 * (also in a cluster). They are not written, but a path outside the roots is
 * the same question whichever way it is opened.
 */
function touchReferences(args: Args): ShellWord[] {
	const out: ShellWord[] = []
	let afterDashes = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		const text = arg.value
		if (afterDashes || text === '-' || !text.startsWith('-')) continue
		if (text === '--') {
			afterDashes = true
			continue
		}
		if (text.startsWith('--')) {
			const eq = text.indexOf('=')
			const name = eq >= 0 ? text.slice(0, eq) : text
			if (name === '--reference') {
				if (eq >= 0) out.push(derived(arg, text.slice(eq + 1)))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
			}
			continue
		}
		for (let j = 1; j < text.length; j += 1) {
			const letter = text[j] as string
			if (letter !== 'r' && letter !== 'd' && letter !== 't') continue
			const rest = text.slice(j + 1)
			if (letter === 'r') {
				if (rest !== '') out.push(derived(arg, rest))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
			} else if (rest === '') i += 1
			break
		}
	}
	return out
}

interface FlagTable {
	readonly booleanShort: string
	readonly valuedShort: string
	readonly attachedShort?: string
	readonly booleanLong: ReadonlySet<string>
	readonly attachedLong?: ReadonlySet<string>
	readonly valuedLong: ReadonlySet<string>
}

/** Operands of a command whose flags are known: an unknown flag stops flag parsing. */
function operandsByTable(table: FlagTable): (args: Args) => ShellWord[] {
	const kind = (flag: string): 'boolean' | 'valued' | 'attached' | 'unknown' => {
		if (flag.startsWith('--')) {
			if (flag.includes('=')) return 'attached'
			if (table.booleanLong.has(flag)) return 'boolean'
			if (table.attachedLong?.has(flag)) return 'attached'
			return table.valuedLong.has(flag) ? 'valued' : 'unknown'
		}
		if (/^-\d+$/.test(flag)) return 'attached'
		for (let i = 1; i < flag.length; i += 1) {
			const letter = flag[i] as string
			if (table.booleanShort.includes(letter)) continue
			if (table.attachedShort?.includes(letter)) return 'attached'
			if (!table.valuedShort.includes(letter)) return 'unknown'
			return i === flag.length - 1 ? 'valued' : 'attached'
		}
		return 'boolean'
	}
	return (args) => {
		const out: ShellWord[] = []
		let afterDashes = false
		let started = false
		let parsing = true
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i] as ShellWord
			if (afterDashes || started) out.push(arg)
			else if (arg.value === '--') afterDashes = true
			else if (arg.value !== '-' && arg.value.startsWith('-')) {
				if (!parsing) continue
				const k = kind(arg.value)
				if (k === 'valued') i += 1
				else if (k === 'unknown') parsing = false
			} else {
				out.push(arg)
				started = true
			}
		}
		return out
	}
}

const set = (...names: string[]): ReadonlySet<string> => new Set(names)

/** Operands of `grep`-family and `rg`: the first operand is the pattern unless `-e`/`-f` gave one. */
function patternThenFiles(
	valued: ReadonlySet<string>,
	fallback: string[] = [],
): (args: Args) => ShellWord[] {
	const patternFlags = ['-e', '--regexp', '-f', '--file']
	const fileFlags = ['-f', '--file']
	const attachedValue = (flag: string, names: readonly string[]): string | undefined => {
		if (!flag.startsWith('-')) return undefined
		const eq = flag.indexOf('=')
		if (eq >= 0) return names.includes(flag.slice(0, eq)) ? flag.slice(eq + 1) : undefined
		for (const name of names) {
			if (name.length === 2 && name[0] === '-' && flag.startsWith(name) && flag !== name) {
				return flag.slice(2)
			}
		}
		return undefined
	}
	return (args) => {
		const out: ShellWord[] = []
		let patternGiven = false
		let afterDashes = false
		let started = false
		const take = (value: string | undefined): void => {
			if (value) out.push(word(value))
		}
		for (let i = 0; i < args.length; i += 1) {
			const arg = args[i] as ShellWord
			const text = arg.value
			if (!afterDashes && !started && text === '--') {
				afterDashes = true
				continue
			}
			if (!afterDashes && !started && text !== '-' && text.startsWith('-')) {
				const eq = text.indexOf('=')
				const name = eq >= 0 ? text.slice(0, eq) : text
				if (patternFlags.includes(name)) {
					patternGiven = true
					if (name === '-f' || name === '--file') {
						take(eq >= 0 ? text.slice(eq + 1) : args[i + 1]?.value)
					}
				}
				if (/^-[a-zA-Z]*f$/.test(name) && name !== '-f' && eq < 0 && args[i + 1] !== undefined) {
					patternGiven = true
					take(args[i + 1]?.value)
					i += 1
					continue
				}
				if (['--exclude-from', '--include-from', '--ignore-file'].includes(name)) {
					take(eq >= 0 ? text.slice(eq + 1) : args[i + 1]?.value)
					if (eq < 0) i += 1
					continue
				}
				if (eq < 0) {
					const attachedFile = attachedValue(text, fileFlags)
					if (attachedFile !== undefined) {
						patternGiven = true
						take(attachedFile)
						continue
					}
					if (text.length > 2 && text.startsWith('-e')) {
						patternGiven = true
						continue
					}
				}
				if (valued.has(name) && eq < 0) i += 1
				continue
			}
			if (started && !afterDashes) {
				const attachedFile = attachedValue(text, fileFlags)
				if (attachedFile !== undefined) take(attachedFile)
			}
			started = true
			if (!patternGiven) {
				patternGiven = true
				continue
			}
			out.push(arg)
		}
		return out.length > 0 ? out : fallback.map(word)
	}
}

/** A synthetic word for a path the extractor derived rather than read. */
function word(value: string): ShellWord {
	return {
		text: value,
		value,
		expands: false,
		quoted: false,
		substitutes: false,
	}
}

const grepOperands = (args: Args): ShellWord[] => {
	const found = patternThenFiles(
		set(
			'-e',
			'--regexp',
			'-f',
			'--file',
			'--exclude',
			'--include',
			'--exclude-dir',
			'--include-dir',
			'-m',
			'--max-count',
			'-A',
			'--after-context',
			'-B',
			'--before-context',
			'-C',
			'--context',
		),
	)(args)
	if (found.length === 0 && args.some((a) => ['-r', '-R', '--recursive'].includes(a.value))) {
		return [word('.')]
	}
	return found
}

const rgOperands = patternThenFiles(
	set(
		'-e',
		'--regexp',
		'-f',
		'--file',
		'-t',
		'--type',
		'-T',
		'--type-not',
		'-g',
		'--glob',
		'-m',
		'--max-count',
		'--max-depth',
		'-r',
		'--replace',
		'-A',
		'--after-context',
		'-B',
		'--before-context',
		'-C',
		'--context',
	),
	['.'],
)

function awkOperands(args: Args): ShellWord[] {
	const valued = set('-F', '--field-separator', '-v', '--assign', '-e', '--source')
	const files = ['-f', '--file', '-E', '--exec']
	const out: ShellWord[] = []
	let afterDashes = false
	let started = false
	let programGiven = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		const text = arg.value
		if (!afterDashes && !started && text === '--') {
			afterDashes = true
			continue
		}
		if (!afterDashes && !started && text !== '-' && text.startsWith('-')) {
			const eq = text.indexOf('=')
			const name = eq >= 0 ? text.slice(0, eq) : text
			if (valued.has(name)) {
				if (name === '-e' || name === '--source') programGiven = true
				if (eq < 0) i += 1
				continue
			}
			if (files.includes(name)) {
				programGiven = true
				if (eq >= 0) out.push(word(text.slice(eq + 1)))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
				continue
			}
			continue
		}
		started = true
		if (!programGiven) {
			programGiven = true
			continue
		}
		out.push(arg)
	}
	return out
}

function sedOperands(args: Args): ShellWord[] {
	const out: ShellWord[] = []
	let skipNext = false
	let scriptGiven = false
	let afterDashes = false
	let started = false
	for (let i = 0; i < args.length; i += 1) {
		if (skipNext) {
			skipNext = false
			continue
		}
		const arg = args[i] as ShellWord
		const text = arg.value
		if (!afterDashes && !started && text === '--') {
			afterDashes = true
			continue
		}
		if (!afterDashes && !started && text !== '-' && text.startsWith('-')) {
			if (text === '-f' || text === '--file') {
				const next = args[i + 1]
				if (next !== undefined) out.push(next)
				skipNext = true
				scriptGiven = true
			} else if (text === '-e' || text === '--expression') {
				skipNext = true
				scriptGiven = true
			} else if (!text.startsWith('--') && (text.includes('e') || text.includes('f'))) {
				scriptGiven = true
			}
			continue
		}
		started = true
		if (!scriptGiven) {
			scriptGiven = true
			continue
		}
		out.push(arg)
	}
	return out
}

function findOperands(args: Args): ShellWord[] {
	const out: ShellWord[] = []
	const takesPath = new Set([
		'-newer',
		'-anewer',
		'-cnewer',
		'-mnewer',
		'-samefile',
		'-path',
		'-wholename',
		'-ilname',
		'-lname',
		'-ipath',
		'-iwholename',
	])
	let expressionStarted = false
	let afterDashes = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		if (!arg.value) continue
		if (afterDashes) {
			out.push(arg)
			continue
		}
		if (arg.value === '--') {
			afterDashes = true
			continue
		}
		if (arg.value.startsWith('-')) {
			if (['-H', '-L', '-P'].includes(arg.value)) continue
			expressionStarted = true
			if (takesPath.has(arg.value) || /^-newer[acmBt][acmtB]$/.test(arg.value)) {
				const next = args[i + 1]
				if (next?.value) {
					out.push(next)
					i += 1
				}
			}
			continue
		}
		if (!expressionStarted) out.push(arg)
	}
	return out.length > 0 ? out : [word('.')]
}

function gitOperands(args: Args): ShellWord[] {
	const valuedGlobals = new Set([
		'-C',
		'-c',
		'--git-dir',
		'--work-tree',
		'--namespace',
		'--super-prefix',
		'--config-env',
		'--attr-source',
		'--shallow-file',
	])
	let index = 0
	let base = ''
	const join = (value: string): string =>
		base === '' ? value : `${base.replace(/\/+$/, '')}/${value}`
	const absolute = (value: string): boolean => value.startsWith('/') || value.startsWith('~')
	const setBase = (value: string): void => {
		base = absolute(value) ? value : join(value)
	}
	while (index < args.length && (args[index] as ShellWord).value.startsWith('-')) {
		const flag = (args[index] as ShellWord).value
		index += 1
		if (valuedGlobals.has(flag) && index < args.length) {
			const value = (args[index] as ShellWord).value
			if (flag === '-C' || flag === '--work-tree') setBase(value)
			index += 1
		} else if (flag.startsWith('--work-tree=')) {
			setBase(flag.slice('--work-tree='.length))
		}
	}
	const sub = args[index]?.value
	const rest = args.slice(index + 1)
	const place = (value: string): string => (base === '' || absolute(value) ? value : join(value))
	if (sub === 'grep') {
		const files = patternThenFiles(
			set(
				'-e',
				'--regexp',
				'-f',
				'--file',
				'-A',
				'--after-context',
				'-B',
				'--before-context',
				'-C',
				'--context',
				'-m',
				'--max-count',
				'--max-depth',
				'--threads',
			),
		)(rest)
		return files.length > 0
			? files.map((f) => word(place(f.value)))
			: [word(base === '' ? '.' : base)]
	}
	if (sub !== 'diff') return []
	const out: ShellWord[] = []
	let afterDashes = false
	for (const arg of rest) {
		if (!afterDashes && arg.value === '--') afterDashes = true
		else if (afterDashes || arg.value === '-' || !arg.value.startsWith('-')) {
			const path = place(arg.value)
			if (!isHarmlessTarget(path)) out.push(word(path))
		}
	}
	return out
}

function manOperands(args: Args): ShellWord[] {
	const local = args.some(
		(a) => a.value === '--local-file' || (/^-[^-]/.test(a.value) && a.value.includes('l')),
	)
	const out: ShellWord[] = []
	args.forEach((arg, i) => {
		const previous = args[i - 1]?.value
		if (i > 0 && (previous === '-C' || previous === '--config-file')) {
			out.push(arg)
			return
		}
		const text = arg.value
		const found: string[] = []
		if (!text.startsWith('-')) found.push(text)
		else {
			if (text.includes('=')) found.push(text.slice(text.indexOf('=') + 1))
			if (text.length > 2 && !text.startsWith('--')) found.push(text.slice(2))
			const cut = text.search(/[\\/~]/)
			if (cut > 0) found.push(text.slice(cut))
		}
		for (const value of new Set(found)) {
			if (
				value !== '' &&
				(local || /[\\/]/.test(value) || value.startsWith('~') || value.startsWith('.'))
			) {
				out.push(word(value))
			}
		}
	})
	return out
}

function jqOperands(args: Args): ShellWord[] {
	const valued = set(
		'-e',
		'--expression',
		'--arg',
		'--argjson',
		'--args',
		'--jsonargs',
		'-L',
		'--library-path',
		'--indent',
		'--tab',
	)
	const out: ShellWord[] = []
	let afterDashes = false
	let filterGiven = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		const text = arg.value
		if (!afterDashes && text === '--') {
			afterDashes = true
			continue
		}
		if (!afterDashes && text.startsWith('-')) {
			const eq = text.indexOf('=')
			const name = eq >= 0 ? text.slice(0, eq) : text
			if (name === '-e' || name === '--expression') filterGiven = true
			if (name === '-f' || name === '--from-file') {
				filterGiven = true
				if (eq >= 0) out.push(word(text.slice(eq + 1)))
				else if (args[i + 1] !== undefined) {
					out.push(args[i + 1] as ShellWord)
					i += 1
				}
				continue
			}
			if (name === '--slurpfile' || name === '--rawfile') {
				const file = args[i + 2]
				if (file !== undefined) out.push(file)
				i += 2
				continue
			}
			if (valued.has(name) && eq < 0) i += 1
			continue
		}
		if (!filterGiven) {
			filterGiven = true
			continue
		}
		out.push(arg)
	}
	return out
}

const trOperands = (args: Args): ShellWord[] => {
	const deleting = args.some(
		(a) =>
			a.value === '-d' ||
			a.value === '--delete' ||
			(a.value.startsWith('-') && a.value.includes('d')),
	)
	return operands(args).slice(deleting ? 1 : 2)
}

const teeOperands = (args: Args): ShellWord[] =>
	operands(args).filter((a) => !isHarmlessTarget(a.value))

const cdOperands = (args: Args): ShellWord[] => {
	const found = operands(args)
	if (found.length === 0) return args[args.length - 1]?.value === '-' ? [word('-')] : [word('~')]
	return [found[0] as ShellWord]
}

const lsOperands = (args: Args): ShellWord[] => {
	const found = operands(args)
	return found.length > 0 ? found : [word('.')]
}

const table = (
	booleanShort: string,
	valuedShort: string,
	booleanLong: ReadonlySet<string>,
	valuedLong: ReadonlySet<string>,
	attachedShort?: string,
	attachedLong?: ReadonlySet<string>,
): FlagTable => ({
	booleanShort,
	valuedShort,
	booleanLong,
	valuedLong,
	attachedShort,
	attachedLong,
})

const EXTRACTORS: Readonly<Record<string, (args: Args) => ShellWord[]>> = {
	cd: cdOperands,
	ls: lsOperands,
	find: findOperands,
	mkdir: operands,
	touch: touchOperands,
	rm: operands,
	rmdir: operands,
	mv: copyOperands,
	cp: copyOperands,
	cat: operands,
	head: operands,
	tail: operands,
	sort: operands,
	uniq: operands,
	wc: operands,
	cut: operandsByTable(
		table(
			'nswz',
			'bcdf',
			set('--complement', '--only-delimited', '--zero-terminated'),
			set('--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter'),
		),
	),
	paste: operandsByTable(
		table('sz', 'd', set('--serial', '--zero-terminated'), set('--delimiters')),
	),
	column: operandsByTable(
		table(
			'txdemLJhV',
			'cosNOClEHRTWrip',
			set(
				'--table',
				'--fillrows',
				'--table-noheadings',
				'--table-header-repeat',
				'--table-maxout',
				'--keep-empty-lines',
				'--json',
			),
			set(
				'--separator',
				'--output-separator',
				'--output-width',
				'--table-name',
				'--table-order',
				'--table-column',
				'--table-columns',
				'--table-columns-limit',
				'--table-noextreme',
				'--table-hide',
				'--table-right',
				'--table-truncate',
				'--table-wrap',
				'--tree',
				'--tree-id',
				'--tree-parent',
			),
		),
	),
	file: operands,
	stat: operands,
	diff: operands,
	awk: awkOperands,
	gawk: awkOperands,
	mawk: awkOperands,
	nawk: awkOperands,
	strings: operands,
	hexdump: operands,
	od: operands,
	base64: operands,
	nl: operands,
	sha256sum: operands,
	sha1sum: operands,
	md5sum: operands,
	tee: teeOperands,
	tr: trOperands,
	grep: grepOperands,
	egrep: grepOperands,
	fgrep: grepOperands,
	tac: operandsByTable(table('br', 's', set('--before', '--regex'), set('--separator'))),
	rev: operands,
	fold: operandsByTable(table('bs', 'w', set('--bytes', '--spaces'), set('--width'))),
	expand: operandsByTable(table('i', 't', set('--initial'), set('--tabs'))),
	unexpand: operandsByTable(table('af', 't', set('--all', '--first-only'), set('--tabs'))),
	fmt: operandsByTable(
		table(
			'csumn',
			'wgdl',
			set('--crown-margin', '--split-only', '--tagged-paragraph', '--uniform-spacing'),
			set('--width', '--goal', '--prefix'),
		),
	),
	comm: operandsByTable(
		table(
			'123iz',
			'',
			set('--check-order', '--nocheck-order', '--total', '--zero-terminated'),
			set('--output-delimiter'),
		),
	),
	cmp: operandsByTable(
		table(
			'blsvxzh',
			'',
			set('--print-bytes', '--verbose', '--quiet', '--silent'),
			set('--ignore-initial', '--bytes'),
		),
	),
	pr: operandsByTable(
		table(
			'acdFfJmprtTv',
			'hlwWoND',
			set(
				'--across',
				'--show-control-chars',
				'--double-space',
				'--form-feed',
				'--join-lines',
				'--merge',
				'--no-file-warnings',
				'--omit-header',
				'--omit-pagination',
				'--show-nonprinting',
			),
			set(
				'--header',
				'--length',
				'--width',
				'--page-width',
				'--indent',
				'--first-line-number',
				'--date-format',
				'--columns',
			),
			'einsS',
			set('--expand-tabs', '--output-tabs', '--number-lines', '--separator', '--sep-string'),
		),
	),
	numfmt: operandsByTable(
		table(
			'z',
			'd',
			set('--grouping', '--zero-terminated', '--debug'),
			set(
				'--from',
				'--to',
				'--from-unit',
				'--to-unit',
				'--format',
				'--padding',
				'--delimiter',
				'--field',
				'--round',
				'--suffix',
				'--invalid',
			),
			undefined,
			set('--header'),
		),
	),
	tsort: operands,
	man: manOperands,
	rg: rgOperands,
	sed: sedOperands,
	jq: jqOperands,
	git: gitOperands,
}

/**
 * Operands of `touch`: the files it changes, with the values of `-d`, `-t` and
 * `-r`/`--reference` taken out (they are a date, a stamp and a file that is read).
 */
function touchOperands(args: Args): ShellWord[] {
	const out: ShellWord[] = []
	let afterDashes = false
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as ShellWord
		const text = arg.value
		if (afterDashes || text === '-' || !text.startsWith('-')) {
			out.push(arg)
			continue
		}
		if (text === '--') {
			afterDashes = true
			continue
		}
		if (text.startsWith('--')) {
			if (/^--(?:reference|date|time)$/.test(text)) i += 1
			continue
		}
		for (let j = 1; j < text.length; j += 1) {
			if ('rdt'.includes(text[j] as string)) {
				if (j === text.length - 1) i += 1
				break
			}
		}
	}
	return out
}

/** Commands that create or change what their operands name. `sed` is added per call when it edits in place. */
const WRITERS = new Set(['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp', 'tee'])

const CD_PROGRAMS = new Set(['cd', 'pushd', 'popd', 'chdir'])

/** `sed -i`, `-i.bak`, `-ni`, `--in-place[=SUFFIX]`: the script's output replaces the file. */
function editsInPlace(args: Args): boolean {
	return args.some((a) => {
		const text = a.value
		if (text === '--') return false
		if (text.startsWith('--')) return text === '--in-place' || text.startsWith('--in-place=')
		return /^-[A-Za-z]*i/.test(text)
	})
}

/** The directory a line is in after `invocation`, given the one before it. */
function directoryAfter(
	before: ShellDirectory | undefined,
	invocation: ShellInvocation,
): ShellDirectory {
	if (before !== undefined && 'unknown' in before) return before
	if (invocation.program !== 'cd') return { unknown: true }
	const operands = invocation.args.filter((a) => a.expands || !/^-[LPe@]+$/.test(a.value))
	const [target, ...extra] = operands
	if (target === undefined || extra.length > 0 || target.expands || target.value === '') {
		return { unknown: true }
	}
	const value = target.value
	if (value === '-' || value === '--' || value.startsWith('/') || value.startsWith('~')) {
		return { unknown: true }
	}
	const base = before?.relative
	return { relative: base === undefined ? value : `${base}/${value}` }
}

/**
 * The paths `reading` names: positional arguments of the commands in the
 * table, and the targets of its redirections.
 *
 * Each use carries the directory an earlier literal `cd` left the shell in
 * (see {@link ShellPathUse.directory}), so a caller can tell
 * `cd packages/sdk && echo x > out.txt` from `cd "$X" && echo x > out.txt`.
 */
export function shellPathAccess(reading: ShellReading): ShellPathAccess {
	const uses: ShellPathUse[] = []
	let changesDirectory = false
	let directory: ShellDirectory | undefined
	const covered = new Set<ShellRedirection>()
	for (const invocation of reading.invocations) {
		const { program, args } = invocation
		if (CD_PROGRAMS.has(program)) changesDirectory = true
		const extract = EXTRACTORS[program]
		if (extract !== undefined) {
			const access: PathAccess =
				WRITERS.has(program) || (program === 'sed' && editsInPlace(args)) ? 'write' : 'read'
			for (const arg of extract(args)) {
				if (arg.value === '' || isHarmlessTarget(arg.value)) continue
				uses.push({
					path: arg.value,
					access,
					via: program,
					unresolved: expandsAtRuntime(arg),
					...(directory !== undefined ? { directory } : {}),
				})
			}
		}
		if (program === 'touch') {
			for (const arg of touchReferences(args)) {
				if (arg.value === '' || isHarmlessTarget(arg.value)) continue
				uses.push({
					path: arg.value,
					access: 'read',
					via: program,
					unresolved: expandsAtRuntime(arg),
					...(directory !== undefined ? { directory } : {}),
				})
			}
		}
		for (const redirection of invocation.redirections ?? []) {
			covered.add(redirection)
			pushRedirection(uses, redirection, directory)
		}
		if (CD_PROGRAMS.has(program)) directory = directoryAfter(directory, invocation)
	}
	for (const redirection of reading.redirections) {
		if (covered.has(redirection)) continue
		// Not tied to a command the reader saw (a compound command's own), so
		// where it runs cannot be told once a `cd` is in the line.
		pushRedirection(uses, redirection, changesDirectory ? { unknown: true } : undefined)
	}
	return { uses, changesDirectory }
}

function pushRedirection(
	uses: ShellPathUse[],
	redirection: ShellRedirection,
	directory: ShellDirectory | undefined,
): void {
	const target = redirection.target
	if (target.value === '' || isHarmlessTarget(target.value)) return
	const where = directory !== undefined ? { directory } : {}
	switch (redirection.operator) {
		case '>':
		case '>>':
		case '>|':
		case '&>':
		case '&>>':
		case '<>':
			uses.push({
				path: target.value,
				access: 'write',
				via: 'redirect',
				unresolved: expandsAtRuntime(target),
				...where,
			})
			break
		case '>&':
			// `>&2` and `>&-` duplicate or close a descriptor; any other word is a file.
			if (!/^(?:\d+-?|-)$/.test(target.value)) {
				uses.push({
					path: target.value,
					access: 'write',
					via: 'redirect',
					unresolved: expandsAtRuntime(target),
					...where,
				})
			}
			break
		case '<':
			uses.push({
				path: target.value,
				access: 'read',
				via: 'redirect',
				unresolved: expandsAtRuntime(target),
				...where,
			})
			break
		default:
			break
	}
}
