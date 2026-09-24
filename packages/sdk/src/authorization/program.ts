/**
 * Where a command line actually execs a program.
 *
 * Three consumers each answered "what program does this command run" their
 * own way — the live `bash` tool's escalation, the scheduled-run floor's
 * `pkill`/`systemctl`/… detection, and a scheduled script's static check —
 * and each guessed differently about a re-exec wrapper (`sudo`, `env`,
 * `nice`, `timeout`, …) standing in front of the real program. A security
 * review found that every one of them only ever looked at
 * `command.words[command.assignments]`, so `env $(echo git) push`,
 * `timeout 5 $(echo systemctl) stop …` and the rest ran unverified: the
 * wrapper's own name is what each check saw, never the word it was actually
 * about to run.
 *
 * `programPositions` is the one place that answer now lives. It unwraps a
 * chain of re-exec wrappers — each with its OWN real option grammar, so
 * `stdbuf -oL prog` and `timeout 5 prog` are read correctly rather than
 * assumed to put the program right after the wrapper's name — and reports
 * every position in the command where a program is actually named: the
 * (possibly wrapped) head, and, for `find`, each `-exec`/`-execdir`/`-ok`/
 * `-okdir` clause's own head.
 *
 * A position is `known` (the literal, non-expanding word that names the
 * program) or `unknown` (why it could not be resolved: the word itself
 * expands, an option this does not recognise stood in the way, or an
 * `xargs` program that is a shell or a `{}` placeholder). Fail closed: an
 * option this does not model makes the position unknown, never "assumed to
 * be the program" and never "assumed harmless".
 *
 * `source`/`.` and `eval` are read the same way a nested `bash -c` payload
 * already is, not as an automatic unknown: `source path`/`. path` with a
 * LITERAL path is known — the position is the `source`/`.` word itself,
 * exactly as `bash path` is known without anyone reading what `path`
 * contains — and unknown only when the path itself expands (`source "$X"`).
 * `eval`'s literal argument words are joined and lexed as a command line of
 * their own, and every position in the commands that come out of that is
 * folded into the result — unknown when that reading is opaque, when any
 * argument word expands, or, transitively, when a position inside the
 * lexed payload is itself unknown (`eval 'env $(echo git) push'`).
 * Consistency review (2026-09-24): treating `eval`/`source`/`.` as
 * automatically unknown "wherever they stand, even literal" made
 * `source .venv/bin/activate` ask alongside `source "$X"`, which is exactly
 * the asymmetry `bash script.sh` (known) versus `bash -c "$X"` (unknown)
 * does not have — the same module read a literal argument two different
 * ways depending only on which command carried it. An `unknown` position
 * still carries `word` when a single word is the reason (the word itself
 * expands, so its value is not known before the line runs) — a caller that
 * only needs "is there a word here that could name any of several tools"
 * (the scheduled-run floor's `pkill`/`systemctl`/… detection) reads that
 * word whether the position is known or not; `unknown` with no `word` is a
 * structural failure with no single culprit (too many wrappers, an
 * unrecognised option, an opaque `eval` payload, a poisoned environment).
 *
 * `hasPoisoningPrefix`, `poisonsLaterCommands` and `poisonedProgramPosition`
 * are the other half a caller iterating a whole script needs: a command
 * that sets `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV` or
 * `IFS` — as a leading assignment (which affects that same command's own
 * program position) or as an `export`/bare assignment (which affects every
 * command after it in the same script) — makes a LATER literal program name
 * unverifiable too: which binary a literal `ls` resolves to depends on
 * `PATH` at the moment it runs, not on the text of the word `ls`.
 * `resolveScriptPrograms` threads that state through a whole script's
 * commands in one pass, for a caller that does not want to write the loop
 * itself.
 */

import { RUNTIME_EVALUATORS } from './command-line.js'
import { skipOneReexecWrapper } from './reexec-wrapper.js'
import {
	NESTED_SHELLS,
	type ShellCommand,
	type ShellDialect,
	type ShellWord,
	basename,
	lexShellCommandLine,
} from './shell-lexer.js'

/**
 * Where a program is named, or why it could not be resolved. `word` is set
 * whenever the position resolves to a specific word — including an unknown
 * one whose OWN text is what is unresolvable (it expands, so its value is
 * not known before the line runs); a caller that only cares "is there a
 * word here that might be any program name" (the scheduled-run floor's
 * scheduler-tool detection) reads `word` regardless of `unknown`. `unknown`
 * with no `word` is a structural failure with no single culprit word — an
 * option on a wrapper this does not recognise, too many wrappers, an opaque
 * `eval` payload, or a poisoned resolution environment.
 */
export type ProgramPosition =
	| { readonly word: ShellWord; readonly unknown?: undefined }
	| { readonly word?: ShellWord; readonly unknown: string }

/** How many re-exec wrappers a chain unwraps before giving up (`sudo env nice … prog`). */
const MAX_WRAPPER_DEPTH = 8

const LITERAL = (w: ShellWord): boolean => !w.expands

/** `NAME=value` read off an assignment word's own text, or null. */
function assignmentName(word: ShellWord): string | null {
	const text = word.text.replace(/\\\n/g, '')
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(text)
	return match && word.value.startsWith(match[0]) ? (match[1] as string) : null
}

type Consumed =
	| { readonly rest: readonly ShellWord[] }
	| { readonly unknown: string }
	| { readonly none: true }

/** A `-c`/`--command` argument found among a wrapper's options — never produced by {@link skipOptions}, only by {@link findDashC}. */
type WithDashC = { readonly payload: ShellWord }

/**
 * `wrapper NAME=value…` sets `NAME` for the wrapped command only (`env
 * NAME=value prog`, `sudo NAME=value prog`) — the same taint a leading
 * command-prefix assignment gives its own command, just spelled through the
 * wrapper instead of in front of it.
 */
function poisonedByWrapperAssignment(wrapper: string, name: string): string {
	return `${wrapper} ${name}=… sets ${name} for the command that follows, so a literal name after it cannot be trusted to resolve to what its text says`
}

/**
 * Scan `words` for a bare `-c`/`--command COMMAND` pair among options this
 * wrapper recognises (everything else validated against `flags`/`withArg`,
 * the same as {@link skipOptions}). `--command=X` is not modelled — a
 * documented, deliberately conservative gap: it falls through to the
 * unrecognised-option path, `unknown` never a silent pass. Returns the `-c`
 * payload when found, the words left after options when it is not (a valid
 * outcome some callers use — `flock`'s positional form, `script`'s bare
 * form), or `unknown` on a bad option or a `-c` given no argument.
 */
function findDashC(
	words: readonly ShellWord[],
	flags: ReadonlySet<string>,
	withArg: ReadonlySet<string>,
	optionalAttached: readonly string[] = [],
): WithDashC | { readonly rest: readonly ShellWord[] } | { readonly unknown: string } {
	let i = 0
	while (i < words.length) {
		const w = words[i] as ShellWord
		if (!LITERAL(w)) return { rest: words.slice(i) }
		if (w.value === '-c' || w.value === '--command') {
			const payload = words[i + 1]
			if (payload === undefined) return { unknown: `${w.value} was given no command` }
			return { payload }
		}
		if (w.value === '--') return { rest: words.slice(i + 1) }
		if (flags.has(w.value)) {
			i += 1
			continue
		}
		if (
			optionalAttached.some((option) =>
				option.startsWith('--')
					? w.value.startsWith(`${option}=`)
					: w.value.startsWith(option) && w.value.length > option.length,
			)
		) {
			i += 1
			continue
		}
		if (withArg.has(w.value)) {
			i += 2
			continue
		}
		const eq = w.value.indexOf('=')
		if (w.value.startsWith('--') && eq > 0 && withArg.has(w.value.slice(0, eq))) {
			i += 1
			continue
		}
		if (/^--?[A-Za-z]/.test(w.value)) {
			return { unknown: `an option this does not read: ${w.value}` }
		}
		return { rest: words.slice(i) }
	}
	return { rest: words.slice(i) }
}

/**
 * Skip a wrapper's own recognised, argument-taking or bare options over
 * `words`, stopping at the first word that is not one of them (the
 * boundary between the wrapper's own invocation and whatever runs next).
 * An option-shaped word (`-x`, `--long`) this does not recognise is
 * `unknown`, never treated as the program; a word this cannot classify
 * because it expands is left for the caller, which already knows to call
 * an expanding program word unknown. `explicit`, when given, names options
 * that ARE recognised but never lead to a named program at all (`sudo -i`
 * runs a runtime-chosen login shell) — checked before `flags`/`withArg`, so
 * the reason is explicit rather than an accident of `flags` swallowing them.
 */
function skipOptions(
	words: readonly ShellWord[],
	flags: ReadonlySet<string>,
	withArg: ReadonlySet<string>,
	explicit?: ReadonlyMap<string, string>,
): Consumed {
	let i = 0
	while (i < words.length) {
		const w = words[i] as ShellWord
		if (!LITERAL(w)) return { rest: words.slice(i) }
		if (w.value === '--') return { rest: words.slice(i + 1) }
		const reason = explicit?.get(w.value)
		if (reason !== undefined) return { unknown: reason }
		if (flags.has(w.value)) {
			i += 1
			continue
		}
		if (withArg.has(w.value)) {
			i += 2
			continue
		}
		const eq = w.value.indexOf('=')
		if (w.value.startsWith('--') && eq > 0 && withArg.has(w.value.slice(0, eq))) {
			i += 1
			continue
		}
		// A short option's value attached to its flag (`-c2`, `-n10`, `-oL`),
		// the conventional form for `ionice`, `nice`, `stdbuf` and `taskset`'s
		// `-c` list — one token, no separate argument word.
		if (!w.value.startsWith('--') && w.value.length > 2 && withArg.has(w.value.slice(0, 2))) {
			i += 1
			continue
		}
		if (/^--?[A-Za-z]/.test(w.value)) {
			return { unknown: `an option this does not read: ${w.value}` }
		}
		return { rest: words.slice(i) }
	}
	return { none: true }
}

/** `xargs`' own options, then its program (the first non-option word, `echo` when there is none). */
function unwrapXargs(words: readonly ShellWord[]): Consumed {
	const flags = new Set(['-0', '-o', '-p', '-r', '-t', '-x', '--null', '--open-tty', '--verbose'])
	const withArg = new Set(['-a', '-d', '-E', '-e', '-I', '-i', '-L', '-l', '-n', '-P', '-s'])
	const skipped = skipOptions(words, flags, withArg)
	if ('unknown' in skipped) return skipped
	const rest = 'none' in skipped ? [] : skipped.rest
	const program = rest[0]
	if (program === undefined) {
		// No program named: xargs' own default is `echo`, always safe.
		return {
			rest: [{ text: 'echo', value: 'echo', expands: false, quoted: false, substitutes: false }],
		}
	}
	if (!LITERAL(program)) return { rest }
	if (program.value === '{}' || NESTED_SHELLS.has(basename(program.value))) {
		return {
			unknown: `xargs' program is built from its input, not named in the line: ${program.text}`,
		}
	}
	return { rest }
}

/**
 * Special command runners. Plain re-exec wrappers are all read by the
 * shared skipOneReexecWrapper, also used by the shell lexer to find -c.
 */
function unwrapOnce(words: readonly ShellWord[]): Consumed | WithDashC | null {
	const head = words[0] as ShellWord
	const name = basename(head.value)
	const rest = words.slice(1)
	switch (name) {
		case 'xargs':
			return unwrapXargs(rest)
		case 'su':
		case 'runuser': {
			const found = findDashC(
				rest,
				new Set(['-p', '--preserve-environment', '-P', '--pty', '-l', '--login', '-']),
				new Set([
					'-s',
					'--shell',
					'-g',
					'--group',
					'-G',
					'--supp-group',
					'-w',
					'--whitelist-environment',
				]),
			)
			if ('unknown' in found) return found
			if ('payload' in found) return found
			// No `-c`/`--command` at all: both start the target user's login
			// or default shell — an interactive session, not a fixed next
			// command this can name.
			return {
				unknown: `${name} without -c/--command starts an interactive login shell, not a named program`,
			}
		}
		case 'script': {
			// Per util-linux `script --help`: `-t[<file>], --timing[=<file>]`
			// is a DEPRECATED ALIAS for `-T`/`--log-timing` with an OPTIONAL
			// value (default file is stderr when bare) — it never consumes a
			// separate following word, unlike the real `-T <file>`. Modelling
			// `-t` as taking one used to swallow a following `-c` as `-t`'s own
			// value, reading `script` as known and never looking at `-c`'s
			// argument at all.
			const flags = new Set([
				'-a',
				'--append',
				'-e',
				'--return',
				'-f',
				'--flush',
				'--force',
				'-q',
				'--quiet',
				'-t',
				'--timing',
			])
			const withArg = new Set([
				'-I',
				'--log-in',
				'-O',
				'--log-out',
				'-B',
				'--log-io',
				'-T',
				'--log-timing',
				'-m',
				'--logging-format',
				'-E',
				'--echo',
				'-o',
				'--output-limit',
			])
			// `script [options] [<file>] [-- <command> [<argument>...]]`: `--`
			// is an alternative to `-c`, running the command directly as an
			// argv (not a joined string re-lexed through a shell) rather than
			// recording an interactive session.
			const dashDash = rest.findIndex((w) => LITERAL(w) && w.value === '--')
			if (dashDash >= 0) {
				const before = skipOptions(rest.slice(0, dashDash), flags, withArg)
				if ('unknown' in before) return before
				const after = rest.slice(dashDash + 1)
				return after.length === 0 ? { none: true } : { rest: after }
			}
			const found = findDashC(rest, flags, withArg, ['-t', '--timing'])
			if ('unknown' in found) return found
			if ('payload' in found) return found
			// No `-c` and no `--`: `script` itself is the program — it
			// records a terminal session (an interactive shell as its own
			// child), and its only other argument is a log file name, not a
			// command to name.
			return { none: true }
		}
		case 'flock': {
			const found = findDashC(
				rest,
				new Set([
					'-s',
					'--shared',
					'-x',
					'-e',
					'--exclusive',
					'-n',
					'--nb',
					'--nonblock',
					'-o',
					'--close',
					'-F',
					'--no-fork',
					'--verbose',
				]),
				new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
			)
			if ('unknown' in found) return found
			if ('payload' in found) return found
			// Positional form (`flock file|directory command [args…]`): what
			// is left after options starts with the locked file/directory
			// (or a bare fd, with no command — nothing execs), then the real
			// argv, run directly — no shell, no joining.
			const target = found.rest[0]
			if (target === undefined) return { none: true }
			const remaining = found.rest.slice(1)
			return remaining.length === 0 ? { none: true } : { rest: remaining }
		}
		default:
			return null
	}
}

/**
 * `source path [args…]` / `. path [args…]`: known at `head` (the
 * `source`/`.` word itself) when `path` is a literal word, exactly as
 * `bash path` is known without reading what `path` contains — trailing
 * words are the sourced script's own positional parameters, not inspected
 * either, the same as `bash path`'s do not name a second program. Unknown,
 * naming `path` itself, when it expands or is absent.
 */
function resolveSourceOrDot(head: ShellWord, args: readonly ShellWord[]): ProgramPosition {
	const path = args[0]
	if (path === undefined) {
		return { word: head, unknown: `${basename(head.value)} was given nothing to run` }
	}
	if (!LITERAL(path)) {
		return { word: path, unknown: `the file this runs is decided at runtime: ${path.text}` }
	}
	return { word: head }
}

/**
 * `eval word…`: bash joins `eval`'s arguments with a space and reads the
 * result as a command line. When every argument word is literal, that joined
 * text is lexed the same way a `bash -c` payload already is, and every
 * position in the commands it contains (poisoning threaded across them,
 * same as any script) is folded into the result — unknown when the reading
 * is opaque or incomplete, and transitively unknown when a position inside
 * it is. An expanding argument word is unknown outright: its value, and so
 * what `eval` will even read, is not known before the line runs. `eval`
 * with no arguments does nothing in bash and names no position at all.
 */
function resolveEvalPayload(
	args: readonly ShellWord[],
	dialect: ShellDialect,
): readonly ProgramPosition[] {
	if (args.length === 0) return []
	for (const arg of args) {
		if (!LITERAL(arg)) {
			return [{ word: arg, unknown: `eval's payload is decided at runtime: ${arg.text}` }]
		}
	}
	const payload = args.map((arg) => arg.value).join(' ')
	const reading = lexShellCommandLine(payload, { dialect })
	if (reading.opaque || !reading.complete) {
		return [
			{
				unknown: `eval's payload cannot be read (${reading.reasons[0] ?? 'a construct the lexer does not model'}): ${payload}`,
			},
		]
	}
	return resolveScriptPrograms(reading.commands, dialect).flatMap((entry) => entry.positions)
}

/** The final position a chain of re-exec wrappers resolves to, from `words` (already literal, non-empty). */
function resolveChain(
	words: readonly ShellWord[],
	dialect: ShellDialect,
): readonly ProgramPosition[] {
	let current = words
	for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
		const head = current[0]
		if (head === undefined) return [{ unknown: 'no program follows this wrapper' }]
		if (!LITERAL(head)) {
			return [{ word: head, unknown: `the program is decided at runtime: ${head.text}` }]
		}
		const name = basename(head.value)
		if (name === 'eval') return resolveEvalPayload(current.slice(1), dialect)
		if (name === 'watch') return resolveWatchArgs(current.slice(1), dialect)
		if (RUNTIME_EVALUATORS.has(name)) {
			// `source`/`.`: `eval` is handled above, on its own, since a
			// literal `eval` reads its payload rather than being the position
			// itself.
			return [resolveSourceOrDot(head, current.slice(1))]
		}
		const wrapper = skipOneReexecWrapper(current)
		if (wrapper !== null) {
			if ('unknown' in wrapper) return [{ unknown: wrapper.unknown }]
			if ('none' in wrapper) return [{ word: head }]
			for (const assignment of wrapper.assignments) {
				if (DYNAMIC_RESOLUTION_VARIABLES.has(assignment)) {
					return [{ unknown: poisonedByWrapperAssignment(name, assignment) }]
				}
			}
			if (wrapper.rest.length === 0) return [{ word: head }]
			current = wrapper.rest
			continue
		}
		const unwrapped = unwrapOnce(current)
		if (unwrapped === null) return [{ word: head }]
		if ('unknown' in unwrapped) return [{ unknown: unwrapped.unknown }]
		if ('none' in unwrapped) return [{ word: head }]
		if ('payload' in unwrapped) return resolveDashCPayload(unwrapped.payload, dialect)
		if (unwrapped.rest.length === 0) return [{ word: head }]
		current = unwrapped.rest
	}
	return [{ unknown: 'too many re-exec wrappers to follow' }]
}

/**
 * A `-c COMMAND` payload (`su -c`, `runuser -c`, `script -c`, `flock -c`):
 * known — recursed into, the same as a nested `bash -c '<literal>'` payload
 * — when literal, unknown when it expands.
 */
function resolveDashCPayload(
	payload: ShellWord,
	dialect: ShellDialect,
): readonly ProgramPosition[] {
	if (!LITERAL(payload)) {
		return [
			{ word: payload, unknown: `the command this runs is decided at runtime: ${payload.text}` },
		]
	}
	const reading = lexShellCommandLine(payload.value, { dialect })
	if (reading.opaque || !reading.complete) {
		return [
			{
				unknown: `this -c payload cannot be read (${reading.reasons[0] ?? 'a construct the lexer does not model'}): ${payload.value}`,
			},
		]
	}
	return resolveScriptPrograms(reading.commands, dialect).flatMap((entry) => entry.positions)
}

/**
 * `watch [options] command…` joins its trailing words with a space and runs
 * them via a shell, exactly the way `eval` does — except with `-x`/`--exec`,
 * which execs the argv directly, no shell, no joining, read the ordinary way.
 */
function resolveWatchArgs(
	rest: readonly ShellWord[],
	dialect: ShellDialect,
): readonly ProgramPosition[] {
	const usesExec = rest.some((w) => LITERAL(w) && (w.value === '-x' || w.value === '--exec'))
	const skipped = skipOptions(
		rest,
		new Set([
			'-d',
			'--differences',
			'-p',
			'--precise',
			'-t',
			'--no-title',
			'-b',
			'--beep',
			'-e',
			'--errexit',
			'-g',
			'--chgexit',
			'-c',
			'--color',
			'-x',
			'--exec',
		]),
		new Set(['-n', '--interval']),
	)
	if ('unknown' in skipped) return [{ unknown: skipped.unknown }]
	const afterOptions = 'rest' in skipped ? skipped.rest : []
	if (afterOptions.length === 0) return []
	return usesExec ? resolveChain(afterOptions, dialect) : resolveEvalPayload(afterOptions, dialect)
}

/** `find`'s own `-exec`/`-execdir`/`-ok`/`-okdir` clauses, each an independent program position. */
function findExecPositions(words: readonly ShellWord[]): ProgramPosition[] {
	const positions: ProgramPosition[] = []
	for (let i = 0; i < words.length; i += 1) {
		const w = words[i] as ShellWord
		if (!LITERAL(w) || !/^-(?:exec|execdir|ok|okdir)$/.test(w.value)) continue
		const clauseStart = i + 1
		let k = clauseStart
		while (k < words.length) {
			const term = words[k] as ShellWord
			if (LITERAL(term) && (term.value === ';' || term.value === '+')) break
			k += 1
		}
		const head = words[clauseStart]
		if (head !== undefined) {
			if (!LITERAL(head)) {
				positions.push({ word: head, unknown: `the program is decided at runtime: ${head.text}` })
			} else if (head.value.includes('{}')) {
				positions.push({
					unknown: `find's own \`{}\` placeholder stands for the program, not a name in the line`,
				})
			} else {
				positions.push({ word: head })
			}
		}
		i = k
	}
	return positions
}

/**
 * Every position in `command` where a program is actually exec'd: the
 * (possibly re-exec-wrapped) head, and, for `find`, each `-exec`-family
 * clause's own head. Empty for a command with no words at all. `dialect` is
 * the shell that will run the line — needed only to read a literal `eval`
 * payload the same way its own commands would be.
 */
export function programPositions(
	command: ShellCommand,
	dialect: ShellDialect,
): readonly ProgramPosition[] {
	const head = command.words[command.assignments]
	if (head === undefined) return []
	const positions: ProgramPosition[] = [
		...resolveChain(command.words.slice(command.assignments), dialect),
	]
	if (LITERAL(head) && basename(head.value) === 'find') {
		positions.push(...findExecPositions(command.words.slice(command.assignments + 1)))
	}
	return positions
}

/** Variables whose value governs how a LATER literal program name resolves to a binary or to code. */
export const DYNAMIC_RESOLUTION_VARIABLES: ReadonlySet<string> = new Set([
	'PATH',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH',
	'BASH_ENV',
	'ENV',
	'IFS',
])

function assignsPoisoningVariable(words: readonly ShellWord[]): boolean {
	for (const word of words) {
		const name = assignmentName(word)
		if (name !== null && DYNAMIC_RESOLUTION_VARIABLES.has(name)) return true
	}
	return false
}

/**
 * Whether `command`'s OWN leading assignment (`PATH=x prog`) sets one of
 * {@link DYNAMIC_RESOLUTION_VARIABLES} — which affects only `prog`'s own
 * position, the way a real command-prefix assignment is scoped to that one
 * invocation and does not leak to later commands. A caller iterating a
 * whole script applies this to THIS command's own {@link programPositions}.
 */
export function hasPoisoningPrefix(command: ShellCommand): boolean {
	return assignsPoisoningVariable(command.words.slice(0, command.assignments))
}

/**
 * Whether `command` sets one of {@link DYNAMIC_RESOLUTION_VARIABLES} for
 * every command AFTER it in the same script: an `export NAME=value` (or a
 * bare re-export, `export NAME`, of an already-set one), or a standalone
 * assignment with no trailing command (`PATH=x` alone), both of which are
 * real, persisting shell-variable assignments rather than a one-call
 * prefix. A caller iterating a whole script applies this to every command
 * that follows, not to `command` itself: a literal `ls` after either one
 * cannot be trusted to resolve to what its text says, since which binary
 * it runs — or what code a shell reads on startup (`BASH_ENV`, `ENV`) —
 * depends on these variables' runtime value.
 */
export function poisonsLaterCommands(command: ShellCommand): boolean {
	const head = command.words[command.assignments]
	if (head === undefined) return hasPoisoningPrefix(command)
	if (!LITERAL(head)) return false
	const args = command.words.slice(command.assignments + 1)
	if (head.value === 'export') {
		// `export -n NAME` REMOVES the export attribute — the opposite of
		// poisoning — for every name in the same invocation; bash reads it
		// once for the whole command, not per name.
		if (args.some((w) => LITERAL(w) && w.value === '-n')) return false
		return args.some((arg) => namesPoisoningVariable(arg))
	}
	if (head.value === 'declare' || head.value === 'typeset') {
		// `declare -x`/`typeset -x` (and a cluster with it, `-gx`, `-xg`, …,
		// but never `+x`, which removes the attribute) marks a name exported,
		// the same as `export`. `declare` without `-x` only sets a local
		// attribute (type, read-only, …) and does not export anything.
		const exports = args.some((w) => LITERAL(w) && /^-[a-zA-Z]*x[a-zA-Z]*$/.test(w.value))
		if (!exports) return false
		return args.some((arg) => {
			if (LITERAL(arg) && /^[-+]/.test(arg.value)) return false // an option, not a name
			return namesPoisoningVariable(arg)
		})
	}
	return false
}

/**
 * `assignmentName`'s prefix, or the word's own literal value for a bare
 * name (`export PATH`, `declare -x PATH`) — read regardless of whether the
 * word's VALUE expands, since only the `NAME` portion (always literal in an
 * assignment word) or the bare word's exact text decides which variable is
 * named.
 */
function namesPoisoningVariable(arg: ShellWord): boolean {
	const name = assignmentName(arg) ?? (LITERAL(arg) ? arg.value : null)
	return name !== null && DYNAMIC_RESOLUTION_VARIABLES.has(name)
}

/**
 * The `unknown` position a command's own program name becomes once
 * {@link hasPoisoningPrefix} or an earlier {@link poisonsLaterCommands} is
 * true for it, in place of whatever {@link programPositions} would
 * otherwise resolve — a literal name is no longer trustworthy once the
 * environment it resolves against is unknown.
 */
export function poisonedProgramPosition(): ProgramPosition {
	return {
		unknown:
			'PATH, LD_PRELOAD, LD_LIBRARY_PATH, BASH_ENV, ENV or IFS was set earlier in this line, so a literal program name here cannot be trusted to resolve to what its text says',
	}
}

/** One command's {@link programPositions}, paired with the command itself. */
export interface CommandProgramPositions {
	readonly command: ShellCommand
	readonly positions: readonly ProgramPosition[]
}

/**
 * {@link programPositions} for every command a script reads, in order,
 * threading {@link hasPoisoningPrefix} and {@link poisonsLaterCommands}
 * through so a literal program name after an earlier `PATH=`, `export
 * PATH=`, … comes back {@link poisonedProgramPosition} rather than trusted
 * at face value. This is the one loop the live `bash` tool's escalation, the
 * scheduled-run floor and `verifyScheduledScript` would otherwise each write
 * for themselves — exactly the duplication that let `env $(echo git) push`
 * pass one consumer's check and not another's.
 */
export function resolveScriptPrograms(
	commands: readonly ShellCommand[],
	dialect: ShellDialect,
): readonly CommandProgramPositions[] {
	let poisoned = false
	const out: CommandProgramPositions[] = []
	for (const command of commands) {
		const selfPoisoned = poisoned || hasPoisoningPrefix(command)
		const positions = selfPoisoned
			? [poisonedProgramPosition()]
			: programPositions(command, dialect)
		out.push({ command, positions })
		if (poisonsLaterCommands(command)) poisoned = true
	}
	return out
}

/**
 * Why a command line's own program name is not knowable ahead of running
 * it, in one call: the line itself, unread whole (`bash -c "$X"`'s outer
 * line is opaque — the lexer could not follow the payload at all, which is
 * a stronger statement than any one position being unresolvable), or a
 * specific command's unresolvable position via {@link resolveScriptPrograms}.
 * The live `bash` tool's escalation (`executor.ts`) calls this directly
 * rather than re-implementing it, so its own tests import the same function
 * they are testing instead of a hand-written mirror that can drift from it.
 */
export function unknownProgramInLine(value: string, dialect: ShellDialect): string | undefined {
	const reading = lexShellCommandLine(value, { dialect })
	if (reading.opaque || !reading.complete) {
		return `${value}: the line cannot be read (${reading.reasons[0] ?? 'a construct the lexer does not model'}), so its program cannot be verified`
	}
	for (const { command, positions } of resolveScriptPrograms(reading.commands, dialect)) {
		for (const position of positions) {
			if (position.unknown !== undefined) return `${command.text}: ${position.unknown}`
		}
	}
	return undefined
}
