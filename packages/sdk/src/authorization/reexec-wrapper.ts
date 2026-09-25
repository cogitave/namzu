/**
 * One layer of a re-exec wrapper (`sudo`, `env`, `nice`, `timeout`, …): the
 * shared "what does this wrapper's own name, options and mandatory
 * arguments consume, and what is left" logic behind two different
 * questions that must never quietly disagree about where a wrapper ends:
 *
 * - the shell lexer's `nestedShellCommand` (`shell-lexer.ts`), which reads a
 *   literal `-c` payload as a command line of its own — and needs to look
 *   PAST a wrapper to find one, since `env -i bash -c "…"` and
 *   `nice -n 5 sh -ec "…"` hide the shell exactly as `bash -c "…"` does,
 *   just one or more words later;
 * - `program.ts`'s `resolveChain`, which asks the same question — is there
 *   a shell hiding behind this wrapper — for the live `bash` tool's
 *   escalation, the scheduled-run floor and `verifyScheduledScript`, and
 *   which ALSO needs to know which `NAME=value` pairs a layer skipped past
 *   (`sudo`'s, `env`'s), to feed a poisoning one (`PATH=`, `LD_PRELOAD=`)
 *   into its own check — this module reports them, but is not itself the
 *   one that judges a name poisoning.
 *
 * A security review found the two questions above answered independently:
 * the lexer's own nested-shell detection only ever looked at the literal
 * head, so `env -i bash -c "$X"` read as an ordinary, unremarkable command
 * (never opaque, so never escalated and never denied on the recovered
 * text), and `toybox sh -c "$X"` was missed entirely (only `busybox` was
 * named); separately, `sudo`'s own unwrapping never skipped a `NAME=value`
 * pair the way `env`'s did, so `sudo VAR=value $(echo ls)` reported the
 * assignment word itself as the program and never looked at the real one.
 * Both questions now go through `unwrapReexecChain`/`shellInvocation`/
 * `shellDashC` here.
 */

import type { ShellWord } from './shell-lexer.js'

export const LITERAL = (w: ShellWord): boolean => !w.expands

/**
 * The last path segment of a word's value. Duplicated from `shell-lexer.ts`
 * (not imported) so this module stays free of a runtime dependency back on
 * it — `shell-lexer.ts` imports FROM here for its own `nestedShellCommand`,
 * and a value-level import cycle between the two would be fragile. Both
 * copies are the same three lines; keep them in sync by hand.
 */
function basename(word: string): string {
	const cut = word.lastIndexOf('/')
	return cut < 0 ? word : word.slice(cut + 1)
}

/** `NAME=value` read off an assignment word's own text, or null. */
export function assignmentName(word: ShellWord): string | null {
	const text = word.text.replace(/\\\n/g, '')
	const match = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(text)
	return match && word.value.startsWith(match[0]) ? (match[1] as string) : null
}

/**
 * Shells whose `-c` this reads, by basename. `shell-lexer.ts` exports this
 * same set as `NESTED_SHELLS`, so the lexer and wrapper reader cannot drift.
 */
export const PLAIN_SHELL_NAMES: ReadonlySet<string> = new Set([
	'sh',
	'bash',
	'dash',
	'zsh',
	'ksh',
	'ash',
	'mksh',
])

/**
 * `rest`, with the `NAME=value` pairs this layer itself skipped over
 * (`env`'s, `sudo`'s) — empty for every other wrapper. A caller that only
 * wants "where does unwrapping continue" reads `.rest`; `program.ts` also
 * reads `.assignments` to judge whether one of them poisons the resolution
 * environment for the command this wrapper runs.
 */
export type WrapperStep =
	| { readonly rest: readonly ShellWord[]; readonly assignments: readonly string[] }
	| { readonly unknown: string }
	| { readonly none: true }

const NO_ASSIGNMENTS: readonly string[] = []

function justRest(rest: readonly ShellWord[]): WrapperStep {
	return { rest, assignments: NO_ASSIGNMENTS }
}

/**
 * Skip a wrapper's own recognised, argument-taking or bare options over
 * `words`, stopping at the first word that is not one of them. An
 * option-shaped word (`-x`, `--long`) this does not recognise is `unknown`,
 * never treated as the program; a word this cannot classify because it
 * expands is left for the caller. `explicit`, when given, names options
 * that ARE recognised but never lead to a named program at all (`sudo -i`
 * runs a runtime-chosen login shell) — checked before `flags`/`withArg`.
 */
export function skipOptions(
	words: readonly ShellWord[],
	flags: ReadonlySet<string>,
	withArg: ReadonlySet<string>,
	explicit?: ReadonlyMap<string, string>,
): WrapperStep {
	let i = 0
	while (i < words.length) {
		const w = words[i] as ShellWord
		if (!LITERAL(w)) return justRest(words.slice(i))
		if (w.value === '--') return justRest(words.slice(i + 1))
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
		// A short option's value attached to its flag (`-c2`, `-n10`, `-oL`).
		if (!w.value.startsWith('--') && w.value.length > 2 && withArg.has(w.value.slice(0, 2))) {
			i += 1
			continue
		}
		if (/^--?[A-Za-z]/.test(w.value)) {
			return { unknown: `an option this does not read: ${w.value}` }
		}
		return justRest(words.slice(i))
	}
	return { none: true }
}

/** Skip leading `NAME=value` words, collecting each name (no judgement about which one — that is `program.ts`'s business). */
function skipAssignmentWords(words: readonly ShellWord[]): WrapperStep {
	let i = 0
	const assignments: string[] = []
	while (i < words.length) {
		const w = words[i] as ShellWord
		if (!LITERAL(w)) return { rest: words.slice(i), assignments }
		const name = assignmentName(w)
		if (name === null) return { rest: words.slice(i), assignments }
		assignments.push(name)
		i += 1
	}
	return { none: true }
}

/** `env [-i] [-0] [-u NAME]… [-C dir] [NAME=value]… [program [args]]`. */
function unwrapEnv(words: readonly ShellWord[]): WrapperStep {
	let i = 0
	const assignments: string[] = []
	for (;;) {
		const w = words[i]
		if (w === undefined) return { none: true }
		if (!LITERAL(w)) return { rest: words.slice(i), assignments }
		if (w.value === '--') return { rest: words.slice(i + 1), assignments }
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
		const name = assignmentName(w)
		if (name !== null) {
			assignments.push(name)
			i += 1
			continue
		}
		if (/^--?[A-Za-z]/.test(w.value)) return { unknown: `an option this does not read: ${w.value}` }
		return { rest: words.slice(i), assignments }
	}
}

/**
 * One level of a re-exec wrapper's own name and options, or `null` when
 * `words[0]` does not name one this reads. `words` is already known
 * literal and non-empty by the caller.
 */
export function skipOneReexecWrapper(words: readonly ShellWord[]): WrapperStep | null {
	const head = words[0] as ShellWord
	const name = basename(head.value)
	const rest = words.slice(1)
	switch (name) {
		case 'env':
			return unwrapEnv(rest)
		case 'sudo': {
			const skipped = skipOptions(
				rest,
				new Set(['-A', '-b', '-E', '-H', '-k', '-K', '-n', '-P', '-S', '-v']),
				new Set(['-g', '-h', '-p', '-u', '-U', '--group', '--host', '--user']),
				new Map([
					['-i', 'sudo -i runs a runtime-chosen login shell, not a named program'],
					['--login', 'sudo --login runs a runtime-chosen login shell, not a named program'],
					['-s', 'sudo -s runs a runtime-chosen shell, not a named program'],
					['--shell', 'sudo --shell runs a runtime-chosen shell, not a named program'],
					['-e', 'sudo -e (sudoedit) opens a runtime-chosen editor, not a named program'],
					['--edit', 'sudo --edit (sudoedit) opens a runtime-chosen editor, not a named program'],
				]),
			)
			if ('unknown' in skipped) return skipped
			// A `sudo NAME=value…` pair sets an environment variable for the
			// sudo'd command only, same as `env`'s.
			return skipAssignmentWords('none' in skipped ? [] : skipped.rest)
		}
		case 'sudoedit':
			return { unknown: 'sudoedit always opens a runtime-chosen editor, not a named program' }
		case 'doas':
			return skipOptions(rest, new Set(['-n']), new Set(['-C', '-u']))
		case 'pkexec':
			return skipOptions(rest, new Set(['--disable-internal-agent']), new Set(['--user']))
		case 'nice': {
			const first = rest[0]
			if (first !== undefined && LITERAL(first) && /^-\d+$/.test(first.value)) {
				return justRest(rest.slice(1))
			}
			return skipOptions(rest, new Set([]), new Set(['-n', '--adjustment']))
		}
		case 'ionice': {
			const skipped = skipOptions(rest, new Set(['-t']), new Set(['-c', '-n']))
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
				const duration = skipped.rest[0]
				if (duration === undefined) return { none: true }
				return justRest(skipped.rest.slice(1))
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
				return justRest(skipped.rest.slice(1))
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
				const mask = skipped.rest[0]
				if (mask === undefined) return { none: true }
				return justRest(skipped.rest.slice(1))
			}
			return skipped
		}
		case 'time':
			return skipOptions(rest, new Set(['-p', '--portability']), new Set([]))
		case 'command': {
			if (rest.some((w) => LITERAL(w) && (w.value === '-v' || w.value === '-V')))
				return { none: true }
			return skipOptions(rest, new Set(['-p']), new Set([]))
		}
		case 'builtin':
			return justRest(rest)
		case 'exec':
			return skipOptions(rest, new Set(['-c', '-l']), new Set(['-a']))
		case 'busybox':
		case 'toybox':
			// A multi-call binary: the next word names the applet to run.
			return justRest(rest)
		case 'unshare':
			return skipOptions(
				rest,
				new Set([
					'-i',
					'--ipc',
					'-m',
					'--mount',
					'-n',
					'--net',
					'-p',
					'--pid',
					'-u',
					'--uts',
					'-U',
					'--user',
					'-C',
					'--cgroup',
					'-T',
					'--time',
					'-f',
					'--fork',
					'-r',
					'--map-root-user',
					'-c',
					'--map-current-user',
					'--mount-proc',
				]),
				new Set([
					'-R',
					'--root',
					'-w',
					'--wd',
					'-S',
					'--setuid',
					'-G',
					'--setgid',
					'-s',
					'--setgroups',
					'--propagation',
				]),
			)
		case 'nsenter':
			return skipOptions(
				rest,
				new Set([
					'-m',
					'--mount',
					'-u',
					'--uts',
					'-i',
					'--ipc',
					'-n',
					'--net',
					'-p',
					'--pid',
					'-C',
					'--cgroup',
					'-U',
					'--user',
					'-T',
					'--time',
					'--preserve-credentials',
					'-r',
					'--root',
					'-w',
					'--wd',
					'-F',
					'--no-fork',
					'-Z',
					'--follow-context',
				]),
				new Set(['-t', '--target', '-S', '--setuid', '-G', '--setgid']),
			)
		case 'chroot': {
			const skipped = skipOptions(
				rest,
				new Set(['--skip-chdir']),
				new Set(['--groups', '--userspec']),
			)
			if ('unknown' in skipped) return skipped
			const afterOptions = 'none' in skipped ? [] : skipped.rest
			const newroot = afterOptions[0]
			if (newroot === undefined) return { none: true }
			const remaining = afterOptions.slice(1)
			return remaining.length === 0
				? { unknown: 'chroot without a command runs an interactive shell, not a named program' }
				: justRest(remaining)
		}
		case 'setpriv':
			return skipOptions(
				rest,
				new Set([
					'--clear-groups',
					'--keep-groups',
					'--no-new-privs',
					'--reset-env',
					'-d',
					'--dump',
				]),
				new Set([
					'--inh-caps',
					'--ambient-caps',
					'--bounding-set',
					'--groups',
					'--pdeathsig',
					'--securebits',
					'--reuid',
					'--ruid',
					'--regid',
					'--rgid',
					'--selinux-label',
					'--apparmor-profile',
				]),
			)
		case 'prlimit': {
			if (rest.some((w) => LITERAL(w) && (w.value === '-p' || w.value === '--pid')))
				return { none: true }
			const resources = [
				'--as',
				'--core',
				'--cpu',
				'--data',
				'--fsize',
				'--locks',
				'--memlock',
				'--msgqueue',
				'--nice',
				'--nofile',
				'--nproc',
				'--rss',
				'--rtprio',
				'--rttime',
				'--sigpending',
				'--stack',
			]
			return skipOptions(
				rest,
				new Set(['--noheadings', '--raw', '--verbose', ...resources]),
				new Set(['-o', '--output', ...resources]),
			)
		}
		case 'numactl': {
			if (
				rest.some(
					(w) =>
						LITERAL(w) &&
						(w.value === '--show' ||
							w.value === '--hardware' ||
							w.value === '-s' ||
							w.value === '-H'),
				)
			) {
				return { none: true }
			}
			return skipOptions(
				rest,
				new Set(['--localalloc', '-l']),
				new Set(['--interleave', '--membind', '--cpunodebind', '--physcpubind', '--preferred']),
			)
		}
		default:
			return null
	}
}

/**
 * Every name {@link skipOneReexecWrapper} recognises — kept in sync BY HAND
 * with its `switch`. A cheap pre-check for a caller (the parser's own
 * `inspect()`) that wants to skip the more expensive chain-following for
 * the overwhelming majority of simple commands that do not start with any
 * of these.
 */
export const REEXEC_WRAPPER_NAMES: ReadonlySet<string> = new Set([
	'env',
	'sudo',
	'sudoedit',
	'doas',
	'pkexec',
	'nice',
	'ionice',
	'nohup',
	'setsid',
	'timeout',
	'stdbuf',
	'chrt',
	'taskset',
	'time',
	'command',
	'builtin',
	'exec',
	'busybox',
	'toybox',
	'unshare',
	'nsenter',
	'chroot',
	'setpriv',
	'prlimit',
	'numactl',
])

/** How many re-exec wrappers a chain unwraps before giving up (`sudo env nice … prog`). */
const MAX_WRAPPER_DEPTH = 8

/**
 * Follow a chain of re-exec wrappers all the way through: `words` with every
 * layer `skipOneReexecWrapper` recognises peeled off, and every `NAME=value`
 * pair skipped along the way, or why it could not be followed to the end.
 * `{ none: true }` when a wrapper consumed everything (nothing left to be a
 * program at all).
 */
export function unwrapReexecChain(words: readonly ShellWord[]): WrapperStep {
	let current = words
	const assignments: string[] = []
	for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
		const head = current[0]
		if (head === undefined) return { none: true }
		if (!LITERAL(head)) return { rest: current, assignments }
		const step = skipOneReexecWrapper(current)
		if (step === null) return { rest: current, assignments }
		if ('unknown' in step) return step
		if ('none' in step) return { none: true }
		assignments.push(...step.assignments)
		if (step.rest.length === 0) return { none: true }
		current = step.rest
	}
	return { unknown: 'too many re-exec wrappers to follow' }
}

/** Where a shell is directly named, or reached through one hop of busybox/toybox applet dispatch. */
export function shellInvocation(
	words: readonly ShellWord[],
): { readonly shell: string; readonly rest: readonly ShellWord[] } | null {
	const head = words[0]
	if (head === undefined || !LITERAL(head)) return null
	const name = basename(head.value)
	if (PLAIN_SHELL_NAMES.has(name)) return { shell: name, rest: words.slice(1) }
	if (name === 'busybox' || name === 'toybox') {
		const applet = words[1]
		if (applet !== undefined && LITERAL(applet) && PLAIN_SHELL_NAMES.has(basename(applet.value))) {
			return { shell: basename(applet.value), rest: words.slice(2) }
		}
	}
	return null
}

/**
 * A shell's own `-c` among its other options (clustered short forms
 * included, `-ec`, `-lc`), the argument right after it, or why none was
 * found. This is exactly the scan `nestedShellCommand` used to run only for
 * a literal head; factored out so a wrapped shell (`env -i bash -c "…"`,
 * `nice -n 5 sh -ec "…"`) is read the identical way.
 */
export function shellDashC(
	rest: readonly ShellWord[],
): { readonly payload: ShellWord } | { readonly none: true } | { readonly unknown: string } {
	let command = false
	let payload: ShellWord | undefined
	for (let i = 0; i < rest.length; i += 1) {
		const word = rest[i] as ShellWord
		if (!LITERAL(word)) return { unknown: 'nested shell option' }
		const value = word.value
		if (value === '--' || value === '-') {
			payload = rest[i + 1]
			break
		}
		if (value.startsWith('--')) {
			if (value === '--rcfile' || value === '--init-file') i += 1
			continue
		}
		if (/^[-+][A-Za-z]+$/.test(value)) {
			if (value.startsWith('-') && value.includes('c')) command = true
			if (/[oO]$/.test(value)) i += 1
			continue
		}
		payload = word
		break
	}
	if (!command) return { none: true }
	if (payload === undefined) return { unknown: 'nested shell without a command' }
	if (!LITERAL(payload)) return { unknown: 'nested shell command is expanded at runtime' }
	return { payload }
}
