/**
 * The dangerous-command floor, read from what a command line RUNS.
 *
 * The floor used to be eleven regular expressions tested against the raw text
 * of the command, every hit a denial that no mode could lift. Two things were
 * wrong with that. It read text, not commands, so `echo "needs sudo"` and a
 * `# sudo` comment were refused as though they ran. And it put two different
 * kinds of thing in one list: acts that cannot be undone, and acts that are
 * merely a person's call (a root shell, a remote login, an `eval`). Bypass and
 * auto mode exist so a person can say "I accept the risk"; a hard denial on
 * `sudo -n true` left them no way to.
 *
 * So there are two tiers, and a finding says which:
 *
 * - `stop`: irreversible, refused in every mode. A recursive removal of the
 *   file system root, the home directory, a top-level directory, or a
 *   variable that may be empty followed by one; a file system created on a
 *   device; a raw write to a device with `dd of=/dev/…`; a fork bomb; a
 *   world-writable root.
 * - `ask`: intent, not damage. `sudo`, `su -`, `ssh user@host`, `eval` of a
 *   dynamic string, a download piped into a shell, and a recursive removal of
 *   the turn's own working directory or a directory above it when the caller
 *   gives `cwd`. The person is asked in the modes that ask and the call is
 *   refused where nobody can answer; bypass and auto lift it as they lift any
 *   other ask. The working directory is in this tier and not the first because
 *   a build tree or a checkout is sometimes removed on purpose, and a floor
 *   that refuses every spelling of it leaves the model no way to say yes.
 *
 * Strict mode (`strict: true`) keeps the old list as it was: every entry a
 * `stop`, matched on the raw text.
 *
 * This is not a security boundary (see `DANGEROUS_PATTERNS`). A command
 * assembled at runtime is read as far as the lexer can see it; the sandbox is
 * the boundary.
 */

import { homedir } from 'node:os'
import { posix } from 'node:path'

import { DANGEROUS_PATTERNS, DANGEROUS_REASONS, FORK_BOMB } from '../constants/tools/index.js'

import { skipOneReexecWrapper } from './reexec-wrapper.js'
import {
	BARE_HOME,
	EMPTY_VARIABLE_ROOT,
	EMPTY_VARIABLE_TOP,
	fold,
	slashes,
	targetsOf,
} from './removal.js'
import {
	type ShellCommand,
	type ShellDialect,
	type ShellWord,
	basename,
	lexShellCommandLine,
} from './shell-lexer.js'

export type DangerousTier = 'stop' | 'ask'

export interface DangerousFinding {
	readonly tier: DangerousTier
	/** What the command does, as a clause that starts with "it": "it removes the file system root". */
	readonly reason: string
}

export interface FindDangerousOptions {
	/** The shell that runs the line; `sh` when unknown, which holds for every POSIX shell. */
	readonly dialect?: ShellDialect
	/** Every entry of the raw-text list is a `stop`. */
	readonly strict?: boolean
	/** The operator's home directory; the host's own when omitted. */
	readonly home?: string
	/** Environment deciding whether a variable may be empty; `process.env` when omitted. */
	readonly env?: Readonly<Record<string, string | undefined>>
	/**
	 * The effective working directory the line will run in, when the caller
	 * knows it (`effectiveBashWorkingDirectory`). A recursive removal of this
	 * folder or of a directory above it is then an `ask`. Omitted, no removal is
	 * read against a working directory the host did not name: `process.cwd()`
	 * is the process the SDK runs in, not the folder the command runs in.
	 */
	readonly cwd?: string
}

/** One program a command runs: the command's own head, or what a wrapper (`sudo`, `env`, `nice`) runs. */
interface Layer {
	readonly program: string
	readonly args: readonly ShellWord[]
}

const MAX_LAYERS = 8

type Variables = ReadonlyMap<string, string>
const NO_VARIABLES: Variables = new Map()

function plainWord(value: string): ShellWord {
	return { text: value, value, expands: false, quoted: false, substitutes: false }
}

/** `NAME=value` assignments of the whole line whose value is written out, for a head word that is a variable. */
function variablesOf(commands: readonly ShellCommand[]): Variables {
	const out = new Map<string, string>()
	for (const command of commands) {
		for (const word of command.words.slice(0, command.assignments)) {
			const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word.value)
			if (match !== null && !word.expands) out.set(match[1] as string, match[2] as string)
		}
	}
	return out
}

/**
 * The program a head word that expands will run, when its text says so: a
 * variable the line sets (`"$S" ls` after `S=sudo`), or a substitution that
 * only prints a name (`$(echo sudo) ls`). `undefined` when it cannot be told.
 */
function resolveHead(head: ShellWord, vars: Variables): string | undefined {
	const variable = /^"?\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))"?$/.exec(head.text)
	if (variable !== null) {
		const value = vars.get((variable[1] ?? variable[2]) as string)
		return value === undefined || /\s/.test(value) ? undefined : basename(value)
	}
	const printed =
		/^"?(?:\$\(|`)\s*(?:echo|printf)\s+(?:-[A-Za-z]+\s+)*(?:'([^'\s]+)'|"([^"\s]+)"|([^\s'"$`()]+))\s*(?:\)|`)"?$/.exec(
			head.text,
		)
	if (printed !== null) {
		const name = printed[1] ?? printed[2] ?? printed[3]
		return name === undefined ? undefined : basename(name)
	}
	return undefined
}

/** `xargs`' own options that take the next word as their value. */
const XARGS_VALUE_OPTIONS = new Set([
	'-I',
	'-n',
	'-P',
	'-L',
	'-l',
	'-s',
	'-d',
	'-E',
	'-e',
	'-a',
	'-J',
	'--arg-file',
	'--delimiter',
	'--max-args',
	'--max-procs',
	'--max-lines',
	'--max-chars',
	'--eof',
	'--process-slot-var',
])

/** The command `xargs` runs, as a word list, or `undefined` when it has none. */
function xargsCommand(args: readonly ShellWord[]): readonly ShellWord[] | undefined {
	for (let i = 0; i < args.length; i += 1) {
		const value = (args[i] as ShellWord).value
		if (value === '--') return args.slice(i + 1)
		if (!value.startsWith('-') || value === '-') return args.slice(i)
		if (XARGS_VALUE_OPTIONS.has(value)) i += 1
	}
	return undefined
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

/** The commands `find -exec … ;` (or `+`) runs, one word list each. */
function findCommands(args: readonly ShellWord[]): readonly ShellWord[][] {
	const out: ShellWord[][] = []
	for (let i = 0; i < args.length; i += 1) {
		if (!FIND_EXEC.has((args[i] as ShellWord).value)) continue
		let end = i + 1
		while (end < args.length && !['+', ';'].includes((args[end] as ShellWord).value)) end += 1
		if (end > i + 1) out.push(args.slice(i + 1, end))
		i = end
	}
	return out
}

function layersOfWords(start: readonly ShellWord[], vars: Variables, used: { n: number }): Layer[] {
	const layers: Layer[] = []
	let words = start
	while (used.n < MAX_LAYERS) {
		used.n += 1
		let head = words[0]
		if (head === undefined) break
		if (head.expands) {
			const name = resolveHead(head, vars)
			if (name === undefined) break
			head = plainWord(name)
			words = [head, ...words.slice(1)]
		}
		const program = basename(head.value)
		const args = words.slice(1)
		layers.push({ program, args })
		if (program === 'xargs') {
			const inner = xargsCommand(args)
			if (inner !== undefined) layers.push(...layersOfWords(inner, vars, used))
			break
		}
		if (program === 'find') {
			for (const inner of findCommands(args)) layers.push(...layersOfWords(inner, vars, used))
			break
		}
		const step = skipOneReexecWrapper(words)
		if (step === null || !('rest' in step) || step.rest.length === 0) break
		words = step.rest
	}
	return layers
}

function layersOf(command: ShellCommand, vars: Variables = NO_VARIABLES): Layer[] {
	return layersOfWords(command.words.slice(command.assignments), vars, { n: 0 })
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ELEVATORS = new Set(['sudo', 'sudoedit', 'doas', 'pkexec'])
const HARMLESS_DEVICES =
	/^\/dev\/(?:null|zero|full|stdout|stderr|stdin|tty|fd\/|(?:shm|pts|tcp|udp)(?:\/|$))/
const isDevice = (value: string): boolean =>
	value.startsWith('/dev/') && !HARMLESS_DEVICES.test(value)

/** Quoted text and comments blanked, so a word inside either never reads as a command. */
function blankQuotedText(line: string): string {
	let out = ''
	let quote: '"' | "'" | undefined
	for (let i = 0; i < line.length; i += 1) {
		const ch = line.charAt(i)
		if (quote !== undefined) {
			if (quote === '"' && ch === '\\') {
				out += '  '
				i += 1
				continue
			}
			if (ch === quote) quote = undefined
			out += ' '
			continue
		}
		if (ch === '\\') {
			out += '  '
			i += 1
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			out += ' '
			continue
		}
		const before = i === 0 ? ' ' : line.charAt(i - 1)
		if (ch === '#' && /[\s;&|()]/.test(before)) {
			const end = line.indexOf('\n', i)
			const stop = end === -1 ? line.length : end
			out += ' '.repeat(stop - i)
			i = stop - 1
			continue
		}
		out += ch
	}
	return out
}

/** Whether `commands[index]` is a download that feeds the next command, a shell, through a pipe. */
function pipesDownloadIntoShell(
	line: string,
	commands: readonly ShellCommand[],
	index: number,
	cursors: { at: number },
	vars: Variables,
): boolean {
	const command = commands[index]
	if (command === undefined || command.origin !== 'line') return false
	const found = line.indexOf(command.text, cursors.at)
	if (found === -1) return false
	cursors.at = found + command.text.length
	const downloads = layersOf(command, vars).some(
		(layer) => layer.program === 'curl' || layer.program === 'wget',
	)
	if (!downloads) return false
	const rest = line.slice(found + command.text.length)
	const piped = /^[ \t]*(?:\\\n[ \t]*)*\|(?!\|)&?\s*/.exec(rest)
	if (piped === null) return false
	const next = commands[index + 1]
	return next !== undefined && layersOf(next, vars).some((layer) => SHELLS.has(layer.program))
}

function hardStop(layer: Layer, options: FindDangerousOptions): DangerousFinding | undefined {
	const { program, args } = layer
	if (program === 'rm' || program === 'rmdir') return irreversibleRemoval(args, options)
	if (/^mkfs(?:\.[A-Za-z0-9_]+)?$/.test(program)) {
		return args.some((arg) => isDevice(arg.value))
			? { tier: 'stop', reason: 'it creates a file system on a device' }
			: undefined
	}
	if (program === 'shred' && args.some((arg) => isDevice(arg.value))) {
		return { tier: 'stop', reason: 'it overwrites a device with shred' }
	}
	if (
		program === 'wipefs' &&
		args.some((arg) => ['-a', '--all', '-f', '--force'].includes(arg.value)) &&
		args.some((arg) => isDevice(arg.value))
	) {
		return { tier: 'stop', reason: 'it erases the signatures of a device with wipefs' }
	}
	if (program === 'find') return irreversibleFind(args, options)
	if (program === 'dd') {
		const target = args.find((arg) => arg.value.startsWith('of=/dev/'))
		if (target !== undefined && isDevice(target.value.slice(3))) {
			return { tier: 'stop', reason: 'it writes raw data to a device with dd' }
		}
		return undefined
	}
	if (program === 'chmod') {
		const modes = args.filter((arg) => /^0?777$/.test(arg.value))
		const onRoot = args.some((arg) => /^\/(?:\*)?$/.test(arg.value))
		if (modes.length > 0 && onRoot)
			return { tier: 'stop', reason: 'it makes the root directory world-writable' }
	}
	return undefined
}

/** A redirection that writes to a device: `cat image > /dev/sda`. */
function deviceWrite(command: ShellCommand): string | undefined {
	for (const redirection of command.redirections) {
		if (!['>', '>>', '>|', '&>', '&>>'].includes(redirection.operator)) continue
		if (isDevice(redirection.target.value))
			return 'it writes raw data to a device with a redirection'
	}
	return undefined
}

const FIND_PLAIN = new Set([
	'-delete',
	'-depth',
	'-d',
	'-xdev',
	'-mount',
	'-print',
	'-print0',
	'-maxdepth',
	'-mindepth',
	'-P',
	'-L',
	'-H',
	'-ignore_readdir_race',
	'-noignore_readdir_race',
	'-follow',
])
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'shred'])

/**
 * `find / -delete` and `find ~ -exec rm {} +` remove what `rm -rf /` would,
 * with the path named by `find` and not by the remover. It is a `stop` only
 * when no test narrows the match (`-name`, `-type`, `-mtime`, …) and a remover
 * runs; the path is then judged as `rm`'s own would be, `find` being recursive
 * by nature. That also puts `find . -delete` on the working directory in the
 * `ask` tier, which `rm`'s own reading of `.` already reaches.
 */
function irreversibleFind(
	args: readonly ShellWord[],
	options: FindDangerousOptions,
): DangerousFinding | undefined {
	const spans = findCommands(args)
	const execs = new Set(args.map((arg) => arg.value).filter((value) => FIND_EXEC.has(value)))
	const removes =
		args.some((arg) => arg.value === '-delete') ||
		spans.some((span) =>
			layersOfWords(span, NO_VARIABLES, { n: 0 }).some((layer) => REMOVERS.has(layer.program)),
		)
	if (!removes) return undefined
	const paths: ShellWord[] = []
	let i = 0
	for (; i < args.length; i += 1) {
		const value = (args[i] as ShellWord).value
		if (['-H', '-L', '-P'].includes(value)) continue
		if (value.startsWith('-') || value === '(' || value === '!') break
		paths.push(args[i] as ShellWord)
	}
	let inExec = false
	for (const arg of args.slice(i)) {
		if (inExec) {
			if (arg.value === ';' || arg.value === '+') inExec = false
			continue
		}
		if (execs.has(arg.value)) {
			inExec = true
			continue
		}
		if (arg.value === '(' || arg.value === ')' || arg.value === '!') return undefined
		if (arg.value.startsWith('-') && !FIND_PLAIN.has(arg.value)) return undefined
	}
	const found = irreversibleRemoval(paths, options, true)
	return found === undefined
		? undefined
		: { tier: found.tier, reason: found.reason.replace(/^it removes/, 'it deletes') }
}

function askReason(layer: Layer): string | undefined {
	const { program, args } = layer
	if (ELEVATORS.has(program)) return `it runs with elevated privileges (${program})`
	if (program === 'su' && args.some((arg) => ['-', '-l', '--login'].includes(arg.value))) {
		return 'it switches user with su -'
	}
	if (
		program === 'ssh' &&
		args.some((arg) => !arg.value.startsWith('-') && /^[^@\s]+@\S/.test(arg.value))
	) {
		return 'it opens a remote shell (ssh user@host)'
	}
	if (
		/^mkfs(?:\.[A-Za-z0-9_]+)?$/.test(program) &&
		args.some((arg) => arg.expands && !arg.value.startsWith('-'))
	) {
		return 'it creates a file system on a path that is only known when it runs'
	}
	if (program === 'eval' && args.some((arg) => arg.quoted || arg.expands)) {
		return 'it evaluates a dynamic string with eval'
	}
	return undefined
}

/**
 * What a removal can do, or `undefined`: the file system root, the home
 * directory, a top-level directory (`/usr`, `/etc`) or a variable that may be
 * empty followed by one (`"$PREFIX/usr"`, `"$DIR/"`) is a `stop`, refused in
 * every mode. A recursive removal of `options.cwd` or of a directory above it
 * is an `ask`: a person says yes, and a run with nobody to ask refuses it.
 *
 * The working folder is the checkout the turn is working in, and everything
 * not committed in it. It is the one folder a wrong path most easily names, and
 * `rm -rf .`, `rm -rf ..` and `find . -delete` are read the same way here as
 * `dangerousRemoval` reads them when it is given a working directory, so a
 * host that has one does not depend on which of the two checks ran.
 *
 * Only a recursive removal asks. `rm file.txt` and `rm dir` leave the folder
 * standing (the second fails without `-r`), and `rm -rf build` is neither.
 */
function irreversibleRemoval(
	args: readonly ShellWord[],
	options: FindDangerousOptions,
	operands = false,
): DangerousFinding | undefined {
	const home = slashes(options.home ?? homedir()).replace(/(?<=.)\/$/, '')
	const env = options.env ?? process.env
	const cwd = options.cwd === undefined ? undefined : slashes(options.cwd)
	const recursive = operands || removesRecursively(args)
	let asked: DangerousFinding | undefined
	for (const target of operands ? args : targetsOf(args)) {
		const spelled = target.value
		if (spelled === '') continue
		if (/^\\+$/.test(spelled)) return { tier: 'stop', reason: 'it removes the drive root' }
		if (BARE_HOME.test(spelled) || /^~\/*(?:\.?\*)?$/.test(spelled)) {
			return { tier: 'stop', reason: 'it removes the home directory' }
		}
		const root = EMPTY_VARIABLE_ROOT.exec(spelled)
		if (root !== null) {
			return {
				tier: 'stop',
				reason: `it removes the file system root when $${root[1] ?? root[2]} is empty`,
			}
		}
		const top = EMPTY_VARIABLE_TOP.exec(spelled)
		if (top !== null) {
			const name = top[1] ?? top[2] ?? ''
			const value = env[name]
			if (typeof value !== 'string' || value === '') {
				return { tier: 'stop', reason: `it removes /${top[3]} when $${name} is empty` }
			}
			continue
		}
		if (/[$`]/.test(spelled)) continue
		if (cwd !== undefined && recursive) {
			const settled = settledRemovalTarget(spelled, cwd)
			if (settled !== undefined && withinOrEqual(settled, cwd) && asked === undefined) {
				asked = { tier: 'ask', reason: workdirRemoval(settled, cwd) }
			}
		}
		if (!spelled.startsWith('/')) continue
		// Trailing slashes and globs reach the same directory's contents.
		const bare = spelled.replace(/(?:\/+\.?\*+)*\/*$/, '')
		const settled = posix.normalize(bare === '' ? '/' : bare).replace(/(?<=.)\/+$/, '')
		if (settled === '/') return { tier: 'stop', reason: 'it removes the file system root' }
		if (/^\/[^/]+$/.test(settled))
			return { tier: 'stop', reason: `it removes the top-level directory ${settled}` }
		if (fold(settled) === fold(home))
			return { tier: 'stop', reason: 'it removes the home directory' }
	}
	return asked
}

/** `rm -r`, `rm -R` and `rm --recursive`, up to the `--` that ends the flags. */
function removesRecursively(args: readonly ShellWord[]): boolean {
	for (const arg of args) {
		if (arg.value === '--') break
		if (/^--r/.test(arg.value) || /^-[A-Za-z]*[rR]/.test(arg.value)) return true
	}
	return false
}

/**
 * A removal target as the directory it names, resolved against `cwd` when it is
 * relative, with trailing slashes and a trailing glob removed (`build/*` names
 * `build`'s contents, which is `build` as far as reaching the working directory
 * goes). `undefined` when the word cannot be settled before the line runs: a
 * tilde path belongs to the home check, and a variable or substitution is not
 * this check's to guess.
 */
function settledRemovalTarget(spelled: string, cwd: string): string | undefined {
	const bare = spelled.replace(/(?:\/+\.?\*+)*\/*$/, '')
	if (bare === '' || bare.startsWith('~') || /^[A-Za-z]:$/.test(bare)) return undefined
	if (bare.startsWith('/')) return posix.normalize(bare)
	return posix.normalize(`${cwd.replace(/\/+$/, '')}/${bare}`)
}

/** Why a removal that reaches the working directory asks, in the tier's words. */
function workdirRemoval(settled: string, cwd: string): string {
	const target = fold(settled).replace(/\/+$/, '')
	return target === fold(cwd).replace(/\/+$/, '')
		? 'it removes the working directory'
		: 'it removes a directory above the working directory'
}

/** Whether `directory` is `child` or a directory above it. */
function withinOrEqual(directory: string, child: string): boolean {
	const parent = fold(slashes(directory)).replace(/\/+$/, '')
	const inside = fold(slashes(child)).replace(/\/+$/, '')
	return parent === '' || inside === parent || inside.startsWith(`${parent}/`)
}

/** Raw-text entries by position in {@link DANGEROUS_PATTERNS}: which are irreversible. */
const STOP_INDEXES = new Set([0, 1, 2, 3, 6])

/**
 * The reading for text that is not a command line the lexer can account for: a
 * tool's whole serialized input, or a line that does not parse. The raw list,
 * with the tier each entry has, and the uncertainty spent against the call.
 */
function findInRawText(text: string, options: FindDangerousOptions): DangerousFinding | undefined {
	let found: DangerousFinding | undefined
	for (const [index, pattern] of DANGEROUS_PATTERNS.entries()) {
		if (!pattern.test(text)) continue
		const tier: DangerousTier = options.strict === true || STOP_INDEXES.has(index) ? 'stop' : 'ask'
		if (found !== undefined && (found.tier === 'stop' || tier === 'ask')) continue
		found = { tier, reason: DANGEROUS_REASONS[index] ?? 'it matches a pattern this tool refuses' }
	}
	return found
}

/**
 * What in `command` the floor refuses or asks about, read from the commands it
 * runs, or `undefined` when nothing. A `stop` outranks an `ask`.
 *
 * `serialized` says `command` is a tool's whole JSON input, not a command line:
 * there is no telling which field runs, so the raw list reads it.
 */
export function findDangerousCommand(
	command: string,
	options: FindDangerousOptions & { readonly serialized?: boolean } = {},
): DangerousFinding | undefined {
	if (options.strict === true || options.serialized === true) return findInRawText(command, options)

	const lexed = lexShellCommandLine(command, { dialect: options.dialect ?? 'sh' })
	let asked: DangerousFinding | undefined

	const masked = blankQuotedText(command)
	if (FORK_BOMB.test(masked)) return { tier: 'stop', reason: 'it defines a fork bomb' }

	const cursors = { at: 0 }
	const vars = variablesOf(lexed.commands)
	for (const [index, each] of lexed.commands.entries()) {
		const layers = layersOf(each, vars)
		const written = deviceWrite(each)
		if (written !== undefined) return { tier: 'stop', reason: written }
		for (const layer of layers) {
			const found = hardStop(layer, options)
			if (found === undefined) continue
			if (found.tier === 'stop') return found
			if (asked === undefined) asked = found
		}
		if (asked === undefined) {
			for (const layer of layers) {
				const reason = askReason(layer)
				if (reason !== undefined) {
					asked = { tier: 'ask', reason }
					break
				}
			}
		}
		if (
			asked === undefined &&
			pipesDownloadIntoShell(command, lexed.commands, index, cursors, vars)
		) {
			asked = { tier: 'ask', reason: 'it pipes a download into a shell' }
		}
	}

	// A line the lexer stopped reading runs text it never showed. What it did
	// not read is tested as raw text, quoted words and comments blanked, so the
	// uncertainty spends against the call without refusing a harmless mention.
	if (!lexed.complete) {
		const rawFound = findInRawText(masked, options)
		if (rawFound !== undefined && (asked === undefined || rawFound.tier === 'stop')) {
			return rawFound
		}
	}
	return asked
}

/**
 * The refusal text for a finding, in the two voices a refusal has. The first
 * line is a plain sentence for the person; the rest tells the model what to do
 * next. A `stop` is final; an `ask` is a question the person answers.
 */
export function describeDangerousFinding(finding: DangerousFinding): string {
	const what = `this command ${finding.reason.replace(/^it /, '')}`
	if (finding.tier === 'ask') {
		return `${what}, so the person is asked before it runs`
	}
	return `${what}.\nNothing ran. Do not retry it or a reworded form; tell the user what you were trying to do and let them run it or decide.`
}
