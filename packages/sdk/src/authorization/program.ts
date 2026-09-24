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

/**
 * Skip a wrapper's own recognised, argument-taking or bare options over
 * `words`, stopping at the first word that is not one of them (the
 * boundary between the wrapper's own invocation and whatever runs next).
 * An option-shaped word (`-x`, `--long`) this does not recognise is
 * `unknown`, never treated as the program; a word this cannot classify
 * because it expands is left for the caller, which already knows to call
 * an expanding program word unknown.
 */
function skipOptions(
	words: readonly ShellWord[],
	flags: ReadonlySet<string>,
	withArg: ReadonlySet<string>,
): Consumed {
	let i = 0
	while (i < words.length) {
		const w = words[i] as ShellWord
		if (!LITERAL(w)) return { rest: words.slice(i) }
		if (w.value === '--') return { rest: words.slice(i + 1) }
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

/** `env [-i] [-0] [-u NAME]… [-C dir] [NAME=value]… [program [args]]`. */
function unwrapEnv(words: readonly ShellWord[]): Consumed {
	let i = 0
	for (;;) {
		const w = words[i]
		if (w === undefined) return { none: true }
		if (!LITERAL(w)) return { rest: words.slice(i) }
		if (w.value === '--') return { rest: words.slice(i + 1) }
		if (w.value === '-i' || w.value === '-0' || w.value === '--ignore-environment') {
			i += 1
			continue
		}
		if (w.value === '-u' || w.value === '-C' || w.value === '--unset' || w.value === '--chdir') {
			i += 2
			continue
		}
		if (/^--(?:unset|chdir)=/.test(w.value)) {
			i += 1
			continue
		}
		if (assignmentName(w) !== null) {
			i += 1
			continue
		}
		if (/^--?[A-Za-z]/.test(w.value)) return { unknown: `an option this does not read: ${w.value}` }
		return { rest: words.slice(i) }
	}
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
 * One level of a re-exec wrapper's own name and options, or `null` when
 * `words[0]` does not name one this reads. `words` is already known
 * literal and non-empty by the caller.
 */
function unwrapOnce(words: readonly ShellWord[]): Consumed | null {
	const head = words[0] as ShellWord
	const name = basename(head.value)
	const rest = words.slice(1)
	switch (name) {
		case 'env':
			return unwrapEnv(rest)
		case 'xargs':
			return unwrapXargs(rest)
		case 'sudo':
			return skipOptions(
				rest,
				new Set(['-A', '-b', '-E', '-H', '-i', '-k', '-K', '-n', '-P', '-S', '-v']),
				new Set(['-g', '-h', '-p', '-u', '-U', '--group', '--host', '--user']),
			)
		case 'doas':
			return skipOptions(rest, new Set(['-n']), new Set(['-C', '-u']))
		case 'pkexec':
			return skipOptions(rest, new Set(['--disable-internal-agent']), new Set(['--user']))
		case 'nice': {
			const first = rest[0]
			if (first !== undefined && LITERAL(first) && /^-\d+$/.test(first.value)) {
				return { rest: rest.slice(1) }
			}
			return skipOptions(rest, new Set([]), new Set(['-n', '--adjustment']))
		}
		case 'ionice': {
			const skipped = skipOptions(rest, new Set(['-t']), new Set(['-c', '-n']))
			// `-p` operates on an existing process; no program follows.
			if (rest.some((w) => LITERAL(w) && w.value === '-p')) return { none: true }
			return skipped
		}
		case 'nohup':
			return skipOptions(rest, new Set([]), new Set([]))
		case 'setsid':
			return skipOptions(rest, new Set(['-w', '-c', '-f']), new Set([]))
		case 'timeout': {
			const skipped = skipOptions(
				rest,
				new Set(['--preserve-status', '--foreground', '-v', '--verbose']),
				new Set(['-s', '-k', '--signal', '--kill-after']),
			)
			if ('rest' in skipped) {
				// The duration is mandatory and not itself a program position.
				const duration = skipped.rest[0]
				if (duration === undefined) return { none: true }
				return { rest: skipped.rest.slice(1) }
			}
			return skipped
		}
		case 'stdbuf':
			return skipOptions(
				rest,
				new Set([]),
				new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
			)
		case 'chrt': {
			if (rest.some((w) => LITERAL(w) && (w.value === '-p' || w.value === '-m')))
				return { none: true }
			const skipped = skipOptions(
				rest,
				new Set(['-b', '-d', '-f', '-i', '-o', '-r', '-a', '-v', '--all-tasks', '--verbose']),
				new Set([]),
			)
			if ('rest' in skipped) {
				const priority = skipped.rest[0]
				if (priority === undefined) return { none: true }
				return { rest: skipped.rest.slice(1) }
			}
			return skipped
		}
		case 'taskset': {
			if (rest.some((w) => LITERAL(w) && w.value === '-p')) return { none: true }
			const skipped = skipOptions(
				rest,
				new Set(['-a', '--all-tasks']),
				new Set(['-c', '--cpu-list']),
			)
			if ('rest' in skipped) {
				const usedCpuList = rest.some(
					(w) =>
						LITERAL(w) &&
						(w.value === '-c' ||
							w.value === '--cpu-list' ||
							w.value.startsWith('--cpu-list=') ||
							(w.value.startsWith('-c') && !w.value.startsWith('--') && w.value.length > 2)),
				)
				if (usedCpuList) return skipped
				// No `-c`: a plain affinity mask is the next (non-program) word.
				const mask = skipped.rest[0]
				if (mask === undefined) return { none: true }
				return { rest: skipped.rest.slice(1) }
			}
			return skipped
		}
		case 'time':
			// bash's reserved-word `time` never reaches here (stripped before
			// the word array); this is `/usr/bin/time` or similar.
			return skipOptions(rest, new Set(['-p', '--portability']), new Set([]))
		case 'command': {
			if (rest.some((w) => LITERAL(w) && (w.value === '-v' || w.value === '-V'))) {
				// A query mode: reports on the name, does not execute it.
				return { none: true }
			}
			return skipOptions(rest, new Set(['-p']), new Set([]))
		}
		case 'builtin':
			return { rest }
		case 'exec':
			return skipOptions(rest, new Set(['-c', '-l']), new Set(['-a']))
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
		if (RUNTIME_EVALUATORS.has(name)) {
			// `source`/`.`: `eval` is handled above, on its own, since a
			// literal `eval` reads its payload rather than being the position
			// itself.
			return [resolveSourceOrDot(head, current.slice(1))]
		}
		const unwrapped = unwrapOnce(current)
		if (unwrapped === null) return [{ word: head }]
		if ('unknown' in unwrapped) return [{ unknown: unwrapped.unknown }]
		if ('none' in unwrapped) return [{ word: head }]
		if (unwrapped.rest.length === 0) return [{ word: head }]
		current = unwrapped.rest
	}
	return [{ unknown: 'too many re-exec wrappers to follow' }]
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
	if (LITERAL(head) && head.value === 'export') {
		for (const arg of command.words.slice(command.assignments + 1)) {
			// `assignmentName` reads the `NAME=` prefix off the word's own text,
			// which is reliable even when the value after `=` expands
			// (`export PATH=$(echo /tmp/evil)`); only the bare re-export form
			// (`export PATH`, no `=`) needs the whole word to be literal, since
			// there the word's value IS the name being exported.
			const name = assignmentName(arg) ?? (LITERAL(arg) ? arg.value : null)
			if (name !== null && DYNAMIC_RESOLUTION_VARIABLES.has(name)) return true
		}
	}
	return false
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
