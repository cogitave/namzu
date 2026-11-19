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
 *   dynamic string, a download piped into a shell. The person is asked in the
 *   modes that ask; bypass and auto lift it as they lift any other ask.
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
}

/** One program a command runs: the command's own head, or what a wrapper (`sudo`, `env`, `nice`) runs. */
interface Layer {
	readonly program: string
	readonly args: readonly ShellWord[]
}

const MAX_LAYERS = 8

function layersOf(command: ShellCommand): Layer[] {
	const layers: Layer[] = []
	let words: readonly ShellWord[] = command.words.slice(command.assignments)
	for (let depth = 0; depth < MAX_LAYERS; depth += 1) {
		const head = words[0]
		if (head === undefined || head.expands) break
		layers.push({ program: basename(head.value), args: words.slice(1) })
		const step = skipOneReexecWrapper(words)
		if (step === null || !('rest' in step) || step.rest.length === 0) break
		words = step.rest
	}
	return layers
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
const ELEVATORS = new Set(['sudo', 'sudoedit', 'doas', 'pkexec'])
const HARMLESS_DEVICES = /^\/dev\/(?:null|zero|full|stdout|stderr|tty|fd\/)/

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
): boolean {
	const command = commands[index]
	if (command === undefined || command.origin !== 'line') return false
	const found = line.indexOf(command.text, cursors.at)
	if (found === -1) return false
	cursors.at = found + command.text.length
	const downloads = layersOf(command).some(
		(layer) => layer.program === 'curl' || layer.program === 'wget',
	)
	if (!downloads) return false
	const rest = line.slice(found + command.text.length)
	const piped = /^[ \t]*(?:\\\n[ \t]*)*\|(?!\|)&?\s*/.exec(rest)
	if (piped === null) return false
	const next = commands[index + 1]
	return next !== undefined && layersOf(next).some((layer) => SHELLS.has(layer.program))
}

function hardStop(layer: Layer, options: FindDangerousOptions): string | undefined {
	const { program, args } = layer
	if (program === 'rm' || program === 'rmdir') return irreversibleRemoval(args, options)
	if (/^mkfs(?:\.[A-Za-z0-9_]+)?$/.test(program)) return 'it creates a file system on a device'
	if (program === 'dd') {
		const target = args.find((arg) => arg.value.startsWith('of=/dev/'))
		if (target !== undefined && !HARMLESS_DEVICES.test(target.value.slice(3))) {
			return 'it writes raw data to a device with dd'
		}
		return undefined
	}
	if (program === 'chmod') {
		const modes = args.filter((arg) => /^0?777$/.test(arg.value))
		const onRoot = args.some((arg) => /^\/(?:\*)?$/.test(arg.value))
		if (modes.length > 0 && onRoot) return 'it makes the root directory world-writable'
	}
	return undefined
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
	if (program === 'eval' && args.some((arg) => arg.quoted || arg.expands)) {
		return 'it evaluates a dynamic string with eval'
	}
	return undefined
}

/**
 * Why a removal can never be undone, or `undefined`: the file system root, the
 * home directory, a top-level directory (`/usr`, `/etc`), or a variable that
 * may be empty followed by one (`"$PREFIX/usr"`, `"$DIR/"`).
 *
 * This is the narrow class refused in every mode. `dangerousRemoval` is the
 * wider one, which asks. A recursive removal of `/tmp/build` or
 * `/usr/local/.wtest` is neither.
 */
function irreversibleRemoval(
	args: readonly ShellWord[],
	options: FindDangerousOptions,
): string | undefined {
	const home = slashes(options.home ?? homedir()).replace(/(?<=.)\/$/, '')
	const env = options.env ?? process.env
	for (const target of targetsOf(args)) {
		const spelled = target.value
		if (spelled === '') continue
		if (/^\\+$/.test(spelled)) return 'it removes the drive root'
		if (BARE_HOME.test(spelled) || /^~\/*(?:\.?\*)?$/.test(spelled)) {
			return 'it removes the home directory'
		}
		const root = EMPTY_VARIABLE_ROOT.exec(spelled)
		if (root !== null) {
			return `it removes the file system root when $${root[1] ?? root[2]} is empty`
		}
		const top = EMPTY_VARIABLE_TOP.exec(spelled)
		if (top !== null) {
			const name = top[1] ?? top[2] ?? ''
			const value = env[name]
			if (typeof value !== 'string' || value === '') {
				return `it removes /${top[3]} when $${name} is empty`
			}
			continue
		}
		if (/[$`]/.test(spelled) || !spelled.startsWith('/')) continue
		// Trailing slashes and globs reach the same directory's contents.
		const bare = spelled.replace(/(?:\/+\.?\*+)*\/*$/, '')
		const settled = posix.normalize(bare === '' ? '/' : bare).replace(/(?<=.)\/+$/, '')
		if (settled === '/') return 'it removes the file system root'
		if (/^\/[^/]+$/.test(settled)) return `it removes the top-level directory ${settled}`
		if (fold(settled) === fold(home)) return 'it removes the home directory'
	}
	return undefined
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
	for (const [index, each] of lexed.commands.entries()) {
		const layers = layersOf(each)
		for (const layer of layers) {
			const stop = hardStop(layer, options)
			if (stop !== undefined) return { tier: 'stop', reason: stop }
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
		if (asked === undefined && pipesDownloadIntoShell(command, lexed.commands, index, cursors)) {
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
