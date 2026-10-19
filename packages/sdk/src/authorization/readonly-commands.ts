/**
 * Which shell lines only read, so that they run without a prompt.
 *
 * The reference terminal runs `ls`, `cat`, `git status` and `git diff` without
 * asking, because each is on a vetted list and nothing in the line is decided
 * at run time. This is that list and those conditions (version 2.1.302):
 *
 * - every command of the line is on the list, the line parses completely, and
 *   nothing in it is read at run time: no `$var` outside single quotes, no
 *   substitution, no subshell or group, no background `&`, no here-document,
 *   no unquoted glob except for a short set of commands that only list or show;
 * - a redirection is allowed only to `/dev/null`, as a descriptor copy, or as
 *   an input from a plain file; a `~user` path and a UNC path are refused;
 * - a leading assignment is allowed only for a variable that cannot change
 *   what a command does (`LANG`, `TZ`, `NO_COLOR`, ...);
 * - `git` must match a vetted subcommand and every flag must be one the table
 *   names, with the kind of value it takes. `git diff --output=f`, `git -c`,
 *   `--exec-path` and `--config-env` are in no table, so they are refused;
 *   `git fetch` is deliberately absent. A `cd` in the same line as `git`
 *   refuses the line, because the directory it enters may hold a repository
 *   the person never looked at.
 *
 * Not ported, and so never read-only here: `sed`, `ps`, `lsof`, `ss`, `date`,
 * `man`, `xargs`, `fd`, `gh`, `docker logs|inspect`, `printf`, `[[`, `test`
 * and the shell builtins other than `cd`. The reference's check of the working
 * directory for a planted bare repository needs the directory, which the tool
 * predicate does not get; the trusted-project gate is what stands in for it.
 *
 * This decides only "does not need a prompt for being a command". The path
 * floor still applies: a read-only command that reads outside the roots is
 * asked about, and so is anything the protected-path and removal floors see.
 */

import type { ShellDialect } from '../types/tool/index.js'
import { FLAG_TABLES, type FlagTable } from './readonly-flags.js'
import { type ShellWord, lexShellCommandLine } from './shell-lexer.js'

/** Lines longer than this are not analysed (the reference's budget). */
const MAX_LINE_LENGTH = 20_000

/** Variables whose value cannot change what a command does. */
const SAFE_ENVIRONMENT: ReadonlySet<string> = new Set([
	'GOEXPERIMENT',
	'GOOS',
	'GOARCH',
	'CGO_ENABLED',
	'GO111MODULE',
	'RUST_BACKTRACE',
	'RUST_LOG',
	'NODE_ENV',
	'PYTHONUNBUFFERED',
	'PYTHONDONTWRITEBYTECODE',
	'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
	'PYTEST_DEBUG',
	'LANG',
	'LANGUAGE',
	'LC_ALL',
	'LC_CTYPE',
	'LC_TIME',
	'CHARSET',
	'TERM',
	'COLORTERM',
	'NO_COLOR',
	'FORCE_COLOR',
	'TZ',
	'LS_COLORS',
	'LSCOLORS',
	'GREP_COLOR',
	'GREP_COLORS',
	'GCC_COLORS',
	'TIME_STYLE',
	'BLOCK_SIZE',
	'BLOCKSIZE',
	'COLUMNS',
	'LINES',
	'CLICOLOR',
	'CLICOLOR_FORCE',
	'CI',
	'DEBIAN_FRONTEND',
	'GIT_TERMINAL_PROMPT',
])

/** Commands that read and print, with any arguments (the reference's bare-safe list). */
const ANY_ARGUMENTS: ReadonlySet<string> = new Set([
	'cal',
	'uptime',
	'cat',
	'head',
	'tail',
	'wc',
	'stat',
	'strings',
	'hexdump',
	'od',
	'nl',
	'id',
	'uname',
	'free',
	'df',
	'du',
	'locale',
	'groups',
	'nproc',
	'basename',
	'dirname',
	'realpath',
	'cut',
	'paste',
	'tr',
	'column',
	'tac',
	'rev',
	'fold',
	'expand',
	'unexpand',
	'fmt',
	'comm',
	'cmp',
	'numfmt',
	'readlink',
	'diff',
	'true',
	'false',
	'sleep',
	'which',
	'type',
	'expr',
	'seq',
	'tsort',
	'pr',
	'echo',
	'ls',
])

/** The commands whose unquoted glob arguments are still read-only. */
const GLOB_OK: ReadonlySet<string> = new Set([
	'ls',
	'cat',
	'head',
	'tail',
	'wc',
	'stat',
	'grep',
	'egrep',
	'fgrep',
	'diff',
	'du',
	'df',
	'echo',
	'strings',
	'hexdump',
	'od',
	'nl',
	'cut',
	'column',
	'tr',
	'tac',
	'rev',
	'cmp',
	'basename',
	'dirname',
	'realpath',
	'readlink',
	'sha256sum',
	'sha1sum',
	'md5sum',
	'cd',
])

const FIND_WRITES: ReadonlySet<string> = new Set([
	'-delete',
	'-rm',
	'-exec',
	'-execdir',
	'-ok',
	'-okdir',
	'-fprint',
	'-fprint0',
	'-fls',
	'-fprintf',
	'-files0-from',
])

/** Options that point `docker` at another daemon, context or config. */
const DOCKER_REMOTE = [
	'-H',
	'-c',
	'-r',
	'--host',
	'--context',
	'--config',
	'--tlscacert',
	'--tlscert',
	'--tlskey',
	'--url',
	'--connection',
	'--identity',
	'--remote',
	'--module',
	'--out',
]
const DOCKER_REMOTE_SHORT = new Set(['H', 'c', 'r'])

const GREP_FAMILY: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep'])

// ---------------------------------------------------------------------------
// the line as text
// ---------------------------------------------------------------------------

/**
 * Whether the line carries syntax the word-level reading cannot vouch for:
 * a variable expansion anywhere but single quotes, a substitution, a subshell, or a `&` that is not `&&` or a descriptor copy.
 */
function hasDynamicSyntax(line: string): boolean {
	let single = false
	let double = false
	for (let i = 0; i < line.length; i += 1) {
		const c = line[i] as string
		if (c === '\\' && !single) {
			i += 1
			continue
		}
		if (c === "'" && !double) {
			single = !single
			continue
		}
		if (c === '"' && !single) {
			double = !double
			continue
		}
		if (single) continue
		if (c === '$') {
			const next = line[i + 1]
			if (next !== undefined && /[A-Za-z_@*#?!$0-9{(-]/.test(next)) return true
		}
		if (c === '`') return true
		if (double) continue
		if (c === '(' || c === ')') return true
		// `{ ls; }` is a group; `HEAD@{1}` and `{a,b}` are words (the latter is
		// refused with the other expansions).
		if (c === '{') {
			const previous = line[i - 1]
			const next = line[i + 1]
			if (
				(previous === undefined || /[\s;&|]/.test(previous)) &&
				(next === undefined || /\s/.test(next))
			)
				return true
		}
		if (c === '&') {
			const previous = line[i - 1]
			const next = line[i + 1]
			if (next === '&' || previous === '&') {
				i += next === '&' ? 1 : 0
				continue
			}
			// `2>&1`, `>&2`, `<&3`: a descriptor copy.
			if (previous === '>' || previous === '<') continue
			return true
		}
	}
	return false
}

/** An unquoted `*`, `?` or `[` in a word's source text. */
function hasUnquotedGlob(text: string): boolean {
	let single = false
	let double = false
	for (let i = 0; i < text.length; i += 1) {
		const c = text[i] as string
		if (c === '\\' && !single) {
			i += 1
			continue
		}
		if (c === "'" && !double) {
			single = !single
			continue
		}
		if (c === '"' && !single) {
			double = !double
			continue
		}
		if (!single && !double && (c === '*' || c === '?' || c === '[')) return true
	}
	return false
}

/** `\\host\share` and `//host/share`: a path the OS may fetch over the network. */
function looksLikeNetworkPath(value: string): boolean {
	return /^(?:\\\\|\/\/)[^\\/]/.test(value)
}

/** A word whose value is not what the shell will pass, other than by a plain glob or `~`. */
function isDynamic(word: ShellWord): boolean {
	// `expands` is false for a single-quoted `$`, which is only text.
	if (word.substitutes || (word.expands && /[$`]/.test(word.value))) return true
	if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(word.text)) return true
	// `~user` expands to another account's home; `~` and `~/x` are this one's.
	return /^~(?!\/|$)/.test(word.text)
}

// ---------------------------------------------------------------------------
// a command's flags
// ---------------------------------------------------------------------------

const FLAG_LIKE = /^-[A-Za-z0-9_-]/

function isFlag(word: string): boolean {
	return word.startsWith('-') && word.length > 1 && FLAG_LIKE.test(word)
}

function valueFits(value: string, kind: 'none' | 'string' | 'number'): boolean {
	if (kind === 'number') return /^\d+$/.test(value)
	return kind === 'string'
}

/** A flag's value that is dynamic or names a network path. */
function dangerousValue(value: string): boolean {
	return /[$`]/.test(value) || looksLikeNetworkPath(value)
}

/**
 * Check `args[start..]` against a flag table: every flag is listed, takes the
 * value its kind says, and (for `string`) that value is not itself a flag.
 */
function flagsAreVetted(
	args: readonly string[],
	start: number,
	flagTable: FlagTable,
	command: string,
): boolean {
	let i = start
	while (i < args.length) {
		const word = args[i] as string
		if (word === '') {
			i += 1
			continue
		}
		if (word === '--') {
			i += 1
			if (flagTable.doubleDash) break
			continue
		}
		if (!isFlag(word)) {
			if (looksLikeNetworkPath(word)) return false
			i += 1
			continue
		}
		const equals = word.indexOf('=')
		const name = equals === -1 ? word : word.slice(0, equals)
		const attached = equals === -1 ? undefined : word.slice(equals + 1)
		const kind = flagTable.flags[name]
		if (kind === undefined) {
			// `git log -5`
			if (command === 'git' && /^-\d+$/.test(name)) {
				i += 1
				continue
			}
			const searching = GREP_FAMILY.has(command) || command === 'rg'
			// `grep -A5`: a count glued to its flag.
			if (searching && name.startsWith('-') && !name.startsWith('--') && name.length > 2) {
				const head = flagTable.flags[name.slice(0, 2)]
				if ((head === 'number' || head === 'string') && /^\d+$/.test(name.slice(2))) {
					i += 1
					continue
				}
			}
			// `-rn`: a cluster of switches, each of which must be a switch.
			if (name.startsWith('-') && !name.startsWith('--') && name.length > 2) {
				for (const letter of name.slice(1))
					if (flagTable.flags[`-${letter}`] !== 'none') return false
				i += 1
				continue
			}
			return false
		}
		if (kind === 'none') {
			if (attached !== undefined) return false
			i += 1
			continue
		}
		let value: string
		if (attached !== undefined) {
			value = attached
			i += 1
		} else {
			const next = args[i + 1]
			if (next === undefined || isFlag(next)) return false
			value = next
			i += 2
		}
		if (dangerousValue(value)) return false
		if (kind === 'string' && value.startsWith('-')) {
			// `git for-each-ref --sort=-committerdate`, but not `--format -x`.
			if (!(name === '--sort' && command === 'git' && /^-[a-zA-Z]/.test(value))) return false
		}
		if (!valueFits(value, kind)) return false
	}
	return true
}

// -- `git` hardening -------------------------------------------------------

const SIGNATURE = /%[-+ ]?G|%\(\*?signature/
const PRETTY_PRESETS = new Set(['oneline', 'short', 'medium', 'full', 'fuller', 'email', 'raw'])

function mentionsHomeDirectory(args: readonly string[]): boolean {
	return args.some((a) => /(?:^|[=:])~/.test(a) || (a.includes('~') && a.includes('{')))
}

/** A `--format`/`--pretty`/`--sort`/`--group` value that runs a program or reads a signature. */
function formatIsDangerous(args: readonly string[]): boolean {
	const bad = (value: string) =>
		mentionsHomeDirectory([value]) ||
		looksLikeNetworkPath(value) ||
		SIGNATURE.test(value) ||
		value.includes('signature')
	for (let i = 0; i < args.length; i += 1) {
		const word = args[i] as string
		if (SIGNATURE.test(word)) return true
		for (const option of ['--format', '--pretty', '--sort', '--group']) {
			let value: string | undefined
			if (word === option && i + 1 < args.length) value = args[i + 1]
			else if (word.startsWith(`${option}=`)) value = word.slice(option.length + 1)
			if (value === undefined) continue
			if (bad(value)) return true
			// A named pretty format that is not a built-in is read from the config.
			if (
				(option === '--format' || option === '--pretty') &&
				value !== '' &&
				!value.includes('%') &&
				!value.startsWith('format:') &&
				!value.startsWith('tformat:') &&
				!PRETTY_PRESETS.has(value)
			)
				return true
		}
	}
	return false
}

type Dangerous = (args: readonly string[]) => boolean

const GIT_CHECKS: Readonly<Record<string, Dangerous>> = {
	'git log': formatIsDangerous,
	'git show': formatIsDangerous,
	'git shortlog': formatIsDangerous,
	'git rev-list': formatIsDangerous,
	'git for-each-ref': formatIsDangerous,
	'git reflog': (args) => {
		const first = args[0]
		if (first !== undefined && !first.startsWith('-') && first !== 'show' && first !== 'list')
			return true
		return args.some((a) => ['expire', 'delete', 'exists', 'drop', 'write'].includes(a))
	},
	'git ls-remote': (args) => {
		if (formatIsDangerous(args)) return true
		let afterDashes = false
		for (let i = 0; i < args.length; i += 1) {
			const word = args[i] as string
			if (!afterDashes && word === '--') {
				afterDashes = true
				continue
			}
			if (!afterDashes && (word === '' || word.startsWith('-'))) {
				if (word === '--sort') i += 1
				continue
			}
			return true
		}
		return false
	},
	'git remote show': (args) => {
		const dashes = args.indexOf('--')
		const options = dashes === -1 ? args : args.slice(0, dashes)
		const operands = dashes === -1 ? [] : args.slice(dashes + 1)
		const rest = options.filter((a) => a !== '-n').concat(operands)
		if (rest.length !== 1) return true
		if (!options.includes('-n')) return true
		return !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(rest[0] as string)
	},
	'git remote': (args) => args.some((a) => a !== '-v' && a !== '--verbose'),
	'git tag': (args) => {
		if (formatIsDangerous(args)) return true
		const takesValue = new Set([
			'--contains',
			'--no-contains',
			'--merged',
			'--no-merged',
			'--points-at',
			'--sort',
			'--format',
			'-n',
		])
		let listing = false
		let afterDashes = false
		let i = 0
		while (i < args.length) {
			const word = args[i] as string
			if (word === '') {
				i += 1
				continue
			}
			if (word === '--' && !afterDashes) {
				afterDashes = true
				i += 1
				continue
			}
			if (!afterDashes && word.startsWith('-')) {
				if (word === '--list' || word === '-l') listing = true
				else if (
					word[1] !== '-' &&
					word.length > 2 &&
					!word.includes('=') &&
					word.slice(1).includes('l')
				)
					listing = true
				if (word.includes('=')) i += 1
				else if (takesValue.has(word)) i += 2
				else i += 1
			} else {
				// A bare word creates a tag unless the list flag came with it.
				if (!listing) return true
				i += 1
			}
		}
		return false
	},
	'git branch': (args) => {
		if (formatIsDangerous(args)) return true
		const takesValue = new Set(['--contains', '--no-contains', '--points-at', '--sort'])
		const optionalCommit = new Set(['--merged', '--no-merged'])
		let listing = false
		let afterDashes = false
		let previous = ''
		let i = 0
		while (i < args.length) {
			const word = args[i] as string
			if (word === '') {
				i += 1
				continue
			}
			if (word === '--' && !afterDashes) {
				afterDashes = true
				previous = ''
				i += 1
				continue
			}
			if (!afterDashes && word.startsWith('-')) {
				if (word === '--list' || word === '-l') listing = true
				else if (word[1] !== '-' && word.length > 2 && !word.includes('=') && word.includes('l'))
					listing = true
				if (word.includes('=')) {
					previous = word.slice(0, word.indexOf('='))
					i += 1
				} else if (takesValue.has(word)) {
					previous = word
					i += 2
				} else {
					previous = word
					i += 1
				}
			} else {
				// A bare word creates a branch unless listing or it is the commit of --merged.
				if (!listing && !optionalCommit.has(previous)) return true
				i += 1
			}
		}
		return false
	},
}

// -- the commands with a regex of their own in the reference ----------------

function uniqIsReadOnly(args: readonly string[]): boolean {
	for (let i = 0; i < args.length; i += 1) {
		const word = args[i] as string
		if (/^-[a-zA-Z]+$/.test(word) || /^--[a-zA-Z-]+(?:=\S+)?$/.test(word)) continue
		// `-f N`, `-s N`, `-w N`
		if (/^-[fsw]$/.test(word)) continue
		if (/^\d+$/.test(word) && /^-[fsw]$/.test(args[i - 1] ?? '')) continue
		return false
	}
	return true
}

function jqIsReadOnly(args: readonly string[]): boolean {
	const text = args.join(' ')
	if (/\b(?:env|include|import)\b|\$ENV/.test(text)) return false
	let filters = 0
	for (const word of args) {
		if (/^-[a-zA-Z]*[fL]/.test(word) && !word.startsWith('--')) return false
		if (
			['--from-file', '--rawfile', '--slurpfile', '--run-tests', '--library-path'].some(
				(x) => word === x || word.startsWith(`${x}=`),
			)
		)
			return false
		if (!word.startsWith('-')) filters += 1
	}
	return filters > 0
}

function findIsReadOnly(args: readonly string[]): boolean {
	return !args.some((word) => FIND_WRITES.has(word))
}

function dockerIsReadOnly(args: readonly string[]): boolean {
	if (args[0] !== 'ps' && args[0] !== 'images') return false
	for (const word of args) {
		if (mentionsHomeDirectory([word]) || looksLikeNetworkPath(word)) return false
		if (DOCKER_REMOTE.some((o) => word === o || word.startsWith(`${o}=`))) return false
		if (word.length > 2 && word.startsWith('-') && !word.startsWith('--')) {
			if (word.startsWith('-H') || word.startsWith('-c') || word.startsWith('-r')) return false
			for (const letter of word.slice(1)) if (DOCKER_REMOTE_SHORT.has(letter)) return false
		}
	}
	return true
}

/** Whether one simple command, as its argument vector, is on the list. */
function commandIsReadOnly(argv: readonly string[], text: string): boolean {
	const [head, ...rest] = argv
	if (head === undefined) return false
	if (ANY_ARGUMENTS.has(head)) return true
	switch (head) {
		case 'pwd':
		case 'whoami':
		case 'alias':
			return rest.length === 0
		case 'cd':
			return rest.length <= 1
		case 'history':
			return rest.length === 0 || (rest.length === 1 && /^\d+$/.test(rest[0] as string))
		case 'arch':
			return rest.length === 0 || (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help'))
		case 'ifconfig':
			return (
				rest.length === 0 ||
				(rest.length === 1 && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(rest[0] as string))
			)
		case 'ip':
			return rest.length === 1 && rest[0] === 'addr'
		case 'node':
			return rest.length === 1 && (rest[0] === '-v' || rest[0] === '--version')
		case 'python':
		case 'python3':
			return rest.length === 1 && rest[0] === '--version'
		case 'claude':
			return rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help')
		case 'uniq':
			return uniqIsReadOnly(rest)
		case 'jq':
			return jqIsReadOnly(rest)
		case 'find':
			return findIsReadOnly(rest)
		case 'docker':
			return dockerIsReadOnly(rest)
		default:
			break
	}
	// Longest table key that starts the vector: `git config --get` before `git`.
	let selected: { key: string; flagTable: FlagTable; words: number } | undefined
	for (const [key, flagTable] of Object.entries(FLAG_TABLES)) {
		const words = key.split(' ')
		if (argv.length < words.length) continue
		if (!words.every((w, i) => argv[i] === w)) continue
		if (selected === undefined || words.length > selected.words)
			selected = { key, flagTable, words: words.length }
	}
	if (selected === undefined) return false
	const { key, flagTable, words } = selected
	const rest2 = argv.slice(words)
	for (const word of rest2) {
		if (word.includes('$')) return false
		if (word.includes('{') && (word.includes(',') || word.includes('..'))) return false
	}
	if (head === 'git' && argv[1] === 'ls-remote') {
		if (argv.some((a) => a === '-o' || a === '--server-option' || a.startsWith('--server-option=')))
			return false
	}
	if (!flagsAreVetted(argv, words, flagTable, head)) return false
	if ((GREP_FAMILY.has(head) || head === 'rg') && /[\n\r]/.test(text)) return false
	const check = GIT_CHECKS[key]
	if (check?.(rest2)) return false
	return true
}

// ---------------------------------------------------------------------------
// redirections
// ---------------------------------------------------------------------------

function redirectionsAreHarmless(
	redirections: readonly {
		readonly operator: string
		readonly target: ShellWord
	}[],
): boolean {
	for (const { operator, target } of redirections) {
		const value = target.value
		if (isDynamic(target)) return false
		if (/^\/dev\/(?:tcp|udp)\//.test(value)) return false
		if (operator === '>&' || operator === '<&') {
			if (/^\d+$/.test(value) || value === '-') continue
			if (value === '/dev/null') continue
			return false
		}
		if (operator === '<') {
			if (looksLikeNetworkPath(value)) return false
			if (/^~(?!\/|$)/.test(target.text)) return false
			continue
		}
		// Any writing operator: only the null device.
		if (value === '/dev/null' && !target.expands) continue
		return false
	}
	return true
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

/**
 * Whether `line` only reads: every command in it is vetted and nothing in it
 * is decided at run time. False for anything this module cannot vouch for.
 */
export function isReadOnlyCommandLine(line: string, dialect: ShellDialect = 'bash'): boolean {
	if (dialect === 'cmd') return false
	if (line.trim() === '' || line.length > MAX_LINE_LENGTH) return false
	if (hasDynamicSyntax(line)) return false
	if (looksLikeNetworkPath(line.trim())) return false

	const lexed = lexShellCommandLine(line, { dialect })
	if (!lexed.complete || lexed.opaque || lexed.commands.length === 0) return false
	if (lexed.compoundWords.length > 0) return false
	if (!redirectionsAreHarmless(lexed.redirections)) return false

	let runsGit = false
	let changesDirectory = false
	for (const command of lexed.commands) {
		if (command.origin !== 'line') return false
		if (!redirectionsAreHarmless(command.redirections)) return false
		for (const word of command.words.slice(0, command.assignments)) {
			const name = word.text.slice(0, Math.max(0, word.text.indexOf('=')))
			if (!SAFE_ENVIRONMENT.has(name) || isDynamic(word) || word.expands) return false
		}
		const words = command.words.slice(command.assignments)
		const head = words[0]
		if (head === undefined || head.expands || head.quoted) return false
		if (head.value.includes('/')) return false

		// A word may differ from what the shell passes only by a plain glob or a
		// leading `~`; anything else (a substitution, a brace list, `~user`, a
		// locale escape) is decided at run time.
		if (words.some(isDynamic)) return false
		const plainExpansion = (word: ShellWord) =>
			hasUnquotedGlob(word.text) || /^~(?:\/|$)/.test(word.text)
		if (words.some((word) => word.expands && !plainExpansion(word))) return false
		const glob = words.some((word) => word.expands && hasUnquotedGlob(word.text))
		if (glob && !GLOB_OK.has(head.value)) return false
		if (words.some((word) => looksLikeNetworkPath(word.value))) return false

		const argv = words.map((word) => word.value)
		if (!commandIsReadOnly(argv, command.text)) return false
		if (head.value === 'git') runsGit = true
		if (head.value === 'cd') changesDirectory = true
	}
	if (runsGit && changesDirectory) return false
	return true
}
