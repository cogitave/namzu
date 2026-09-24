/**
 * The scheduled-run floor: what no scheduled run may do, whatever its rules
 * say.
 *
 * A scheduled run must not reach its own scheduler — stop, disable or remove
 * the service, or run a `namzu schedule` subcommand that changes something —
 * and must not name `NAMZU_HOME`, where its job, its history, the daemon's
 * endpoint token and the credentials beside them live, nor the Windows
 * browser's profile folder (`%LOCALAPPDATA%\namzu`), where namzu keeps the
 * profiles it drives from WSL with the cookies of every site the operator
 * signed in to.
 *
 * ## Why this is code and not patterns
 *
 * The floor used to be regular expressions over the command line's text.
 * A pattern about what a line RUNS has to re-implement the shell's quoting to
 * see through `'sched'ule`, `$'\x73'chedule`, `sche\<newline>dule` and
 * `namzu --add-dir ';' schedule stop`, and each review round found another
 * form it missed, plus a pattern that backtracked quadratically. The SDK
 * reads a command line once, with the lexer the gate itself uses
 * (`lexShellCommandLine`, checked against real bash), and this module decides
 * on what that lexer reports: the words bash will pass to each simple
 * command, after quote removal and `$'…'` decoding, the payload of a nested
 * `bash -c`, every redirection target, and the words of `for` lists and
 * `case` statements. Quoting is the lexer's business; this file never
 * mentions a quote character except in the tripwire below.
 *
 * ## What is decided, and how
 *
 * - **Scheduler commands**, on each simple command's words in order,
 *   anywhere in the command, so `sudo`, `env`, `nohup` or `timeout` in front
 *   changes nothing: `systemctl` + a stopping verb + a unit naming namzu (or
 *   a glob), `launchctl` + a removing verb + a namzu label, `schtasks` with a
 *   `/delete`, `/change` or `/end` switch and a namzu task in any order,
 *   `pkill`/`killall` with a pattern that could match the daemon,
 *   `busctl`/`dbus-send`/`gdbus` naming namzu, and the CLI (`namzu` or a path
 *   to it, `@namzu/cli`, a `bin.js`, or a JavaScript runtime) with `schedule`
 *   followed by anything but a read-only verb. A word that expands at
 *   runtime (`$V`) stands for any word in any of those places; one whose only
 *   expansion is locale quoting (`$"stop"`) is read as its text.
 * - **NAMZU_HOME**, on every word, redirection target, `for` list and `case`
 *   word: `~` (where bash expands it), `$HOME`, `${HOME}`, `$NAMZU_HOME` and
 *   `$PWD` are expanded here from known values, as are variables the line
 *   itself assigns; `..` and `.` are resolved; a relative path is resolved
 *   against the job's folder and every directory a `cd` before it names.
 *   Where a word still holds an unknown expansion or a glob, it is denied
 *   when the known part before it could lead into NAMZU_HOME (`~/.nam*`,
 *   `~/$X`, `/$X`), or the text after it names NAMZU_HOME's last segment. An
 *   assignment standing alone reaches no program and is judged where the
 *   variable is used; one that is exported is judged where it stands.
 * - **What the lexer cannot account for** — an opaque line (a command
 *   substitution, `eval`-like constructs, a syntax error, a construct it does
 *   not model), a command whose name expands, or a program that runs text as
 *   code (`sh` reading its input, `sudo bash -c`, `powershell`, `python`,
 *   `xargs`, `watch` …) — is denied when the line's text holds something that
 *   could reach what the floor protects (see {@link Floor.tripwire}): a
 *   `schedule` subcommand that changes something with the CLI or an
 *   expansion in reach, the scheduler service's name, a service tool with a
 *   namzu name, a process killer, `NAMZU_HOME` by name or path, or the
 *   Windows browser's profile folder. That is the tripwire, deliberately
 *   textual and cheap. The product's name on its own is not in that list: a
 *   message box saying "Namzu: scheduled job running" reaches nothing, and a
 *   run that showed one was refused for it. Text such a program may run — an
 *   argument, a here-string, a here-document's body — is also read as a
 *   command line of its own, so an escape only the inner shell undoes does
 *   not hide it.

 * - **The Windows browser's profiles**, on the same words, spellings and
 *   directories: a path whose segments run `AppData/Local/namzu` (any user,
 *   any drive, `/mnt/c/Users/<you>/…` or `C:\Users\<you>\…`, either slash,
 *   any letter case), with `%LOCALAPPDATA%`, `$env:LOCALAPPDATA` and
 *   `$LOCALAPPDATA` spelled out. The user folder above it is not known here,
 *   so the three segments are what is matched. Where a word holds an unknown
 *   expansion or a glob, it is denied when its segments could still read
 *   `AppData/Local/namzu` and one of them is spelled out, or when an unknown
 *   expansion is followed by a `namzu` segment.

 * Every other tool's arguments are strings, not shell: each is searched for
 * NAMZU_HOME and the browser's profiles by path, in any letter case, with
 * `~`, `$HOME`, `$NAMZU_HOME` and `%LOCALAPPDATA%` spelled out, and once more
 * with shell quotes and backslashes dropped, in case the tool hands it to a
 * shell.
 *
 * Everything here is linear in the input.
 */

import {
	type AuthorizationPredicateCall,
	type AuthorizationRule,
	type ShellCommand,
	type ShellLexResult,
	type ShellRedirection,
	type ShellWord,
	builtinCommandArguments,
	commandArgumentOf,
	lexShellCommandLine,
	nestedShellCommand,
} from '@namzu/sdk'

/** Scheduler verbs a run may use: they read, they change nothing. */
export const READ_ONLY_VERBS: readonly string[] = ['list', 'show', 'status', 'history', 'logs']

export interface FloorOptions {
	/** The scheduler's `NAMZU_HOME`. */
	readonly namzuHome: string
	/** The home directory `~` and `$HOME` name. */
	readonly userHome: string
	/**
	 * The directories a relative path starts from before any `cd`: the job's
	 * folder (as written and canonical). Absent, a relative path is resolved
	 * against nothing and only an absolute one is checked.
	 */
	readonly folders?: readonly string[]
	/**
	 * The command line the scheduler daemon runs under, for `pkill -f`.
	 * Defaults to this process's own node and entry script.
	 */
	readonly daemonCommandLine?: string
}

/** What the floor keeps a run's paths out of. */
export type FloorProtected = 'NAMZU_HOME' | 'the browser profiles'

/** Why the floor denied a call: for tests and diagnostics. */
export type FloorReason =
	| `names ${FloorProtected}`
	| 'scheduler command'
	| `word names ${FloorProtected}`
	| `assigned value names ${FloorProtected}`
	| `redirection names ${FloorProtected}`
	| `loop or case word names ${FloorProtected}`
	| 'opaque line mentions a protected name'
	| 'unread text mentions a protected name'
	| 'encoded command cannot be read at all'
	| 'too many spellings'

/** Why the floor denied a call, and what in it matched. */
export interface FloorFinding {
	readonly reason: FloorReason
	/**
	 * The rule that matched, in words: the token or word, and the argument,
	 * redirection or text it stands in. This, not the list of everything the
	 * floor protects, is what a refusal says.
	 */
	readonly detail: string
}

/** The floor's reason for denying a call, or null: what the rule below decides on. */
export function scheduledRunFloorVerdict(
	options: FloorOptions,
): (call: AuthorizationPredicateCall) => FloorReason | null {
	const floor = new Floor(options)
	return (call) => floor.find(call)?.reason ?? null
}

/** The floor's finding for a call, or null: the reason and what matched. */
export function scheduledRunFloorFinding(
	options: FloorOptions,
): (call: AuthorizationPredicateCall) => FloorFinding | null {
	const floor = new Floor(options)
	return (call) => floor.find(call)
}

/** What a refusal says: the rule that matched, and that another wording will not help. */
export function floorRefusal(finding: FloorFinding): string {
	return `the scheduled-run floor refused this call: ${finding.detail}. It holds for every scheduled run, so rewording the call will not help`
}

/**
 * Rules this module made, which decide `deny` or nothing: a rule here never
 * lets a call through, so a tool it covers may still be withheld from a run.
 */
const DENY_ONLY = new WeakSet<AuthorizationRule>()

/** Whether `rule` is the floor's, and so can only deny. */
export function isFloorRule(rule: AuthorizationRule): boolean {
	return DENY_ONLY.has(rule)
}

/** The floor as one gate rule. */
export function scheduledRunFloorRule(options: FloorOptions): AuthorizationRule {
	const floor = new Floor(options)
	const rule: AuthorizationRule = {
		type: 'predicate',
		description: `the scheduled-run floor: a scheduled run may not stop, disable or remove the scheduler, run a \`namzu schedule\` subcommand other than ${READ_ONLY_VERBS.join(', ')}, or name NAMZU_HOME (${options.namzuHome}) or the Windows browser's profile folder (%LOCALAPPDATA%\\namzu) in any argument. It holds for every scheduled run, so rewording the call will not help`,
		decide: (call) => (floor.find(call) === null ? null : 'deny'),
		// Asked only after `decide` denied, so the reading is done twice for a
		// refused call and once for every other.
		describe: (call) => {
			const finding = floor.find(call)
			return finding ? floorRefusal(finding) : null
		},
	}
	DENY_ONLY.add(rule)
	return rule
}

// ---------------------------------------------------------------------------
// Words

const SYSTEMCTL_VERBS_WITH_UNIT = new Set([
	'stop',
	'disable',
	'mask',
	'edit',
	'kill',
	'revert',
	'freeze',
	'set-property',
	'clean',
])
/** Verbs that stop units without naming them. */
const SYSTEMCTL_VERBS_ALONE = new Set(['isolate', 'exit'])
const LAUNCHCTL_VERBS = new Set(['bootout', 'unload', 'remove', 'disable', 'kill', 'stop'])
const SCHTASKS_SWITCH = /^[/-](?:delete|change|end)$/
const DBUS_TOOLS = new Set(['busctl', 'dbus-send', 'gdbus'])
/** Runtimes the CLI can be started through without its name in the line. */
const JS_RUNTIMES = new Set([
	'node',
	'nodejs',
	'npx',
	'pnpx',
	'bunx',
	'bun',
	'deno',
	'tsx',
	'ts-node',
	'npm',
	'pnpm',
	'yarn',
])
const CLI_ENTRY = /^bin(?:\.[cm]?js)?$/
/** Shells: a payload the lexer did not follow (stdin, a script, `sudo bash -c`) is text it never read. */
const SHELLS = new Set([
	'sh',
	'bash',
	'dash',
	'zsh',
	'ksh',
	'ash',
	'mksh',
	'busybox',
	'fish',
	'csh',
	'tcsh',
	'pwsh',
	'powershell',
	'cmd',
	'wsl',
])
/** Programs that run a string, a file or their input as code or as a command. */
const INTERPRETERS =
	/^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl[0-9.]*|ruby|php[0-9.]*|lua[0-9.]*|luajit|osascript|awk|gawk|mawk|nawk|sed|gsed|tclsh|wish|expect|eval|source|xargs|parallel|watch|su|runuser|ssh|script|flock|at|batch|crontab)$/
/** Options that make `sudo` or `env` run a string rather than an argv. */
const STRING_OPTIONS: Readonly<Record<string, RegExp>> = {
	sudo: /^-(?:[a-z]*[si][a-z]*|-shell|-login)$/,
	env: /^-(?:[a-z]*s[a-z]*|-split-string(?:=.*)?)$/i,
}

/** PowerShell's two names, wherever the floor treats them as an unread shell. */
const POWERSHELL_NAMES = new Set(['powershell', 'pwsh'])
/**
 * `-EncodedCommand` and every unambiguous prefix PowerShell itself accepts
 * (`-e`, `-en`, `-enc`, …, up to the full name), case-insensitive. Unlike
 * `-Command`/`-c`, whose literal text the tripwire can still read, the
 * argument here is base64 of UTF-16LE: nothing in it can be read as text, so
 * a line the tripwire finds nothing in front of proves nothing about what it
 * runs.
 */
const ENCODED_COMMAND_FLAG =
	/^-e(?:n(?:c(?:o(?:d(?:e(?:d(?:c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i

/** What a refusal says about a `schedule` verb that is not read-only. */
const NOT_READ_ONLY = `a \`namzu schedule\` subcommand other than ${READ_ONLY_VERBS.join(', ')}`

const NAME_CHAR = /[a-z0-9._-]/

function lower(text: string): string {
	return text.toLowerCase()
}

/** The last path segment, lower-cased, with `.exe` dropped. */
function commandName(value: string): string {
	const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
	const base = lower(cut < 0 ? value : value.slice(cut + 1))
	return base.endsWith('.exe') ? base.slice(0, -4) : base
}

/** Text as a refusal quotes it: on one line, cut to `max` characters, in backticks. */
function shown(text: string, max = 80): string {
	const flat = text.replace(/\s*\n\s*/g, ' ⏎ ')
	const cut = [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat
	return cut.includes('`') ? `\`\` ${cut} \`\`` : `\`${cut}\``
}

interface Word {
	/** Lower-cased value. */
	readonly text: string
	/** True when the value is not what bash passes (an expansion, a glob). */
	readonly wild: boolean
}

/**
 * `$"…"` read as its text. The lexer leaves locale quoting as written and
 * flags the word, because a translation catalogue could change it; the text
 * itself is what a C locale passes.
 */
function unlocale(value: string): string {
	return value.includes('$"')
		? value.replace(/\$"((?:[^"\\]|\\.)*)"/g, (_, inner: string) =>
				inner.replace(/\\([$`"\\\n])/g, '$1'),
			)
		: value
}

/**
 * A word whose only expansion is locale quoting, read as its C-locale text,
 * unless the line can choose a translation catalogue (`TEXTDOMAIN`,
 * `TEXTDOMAINDIR`), which could turn `$"status"` into anything.
 */
function localeOnly(value: string, catalogue: boolean): boolean {
	return !catalogue && value.includes('$"') && !/[$`*?[{~]/.test(unlocale(value))
}

function wordsOf(command: ShellCommand, catalogue: boolean): Word[] {
	return command.words.map((w) => {
		const text = w.expands ? unlocale(w.value) : w.value
		return { text: lower(text), wild: w.expands && !localeOnly(w.value, catalogue) }
	})
}

// ---------------------------------------------------------------------------
// Scheduler commands

/**
 * Whether one command's words, in order, reach the scheduler, and if so what
 * they do, in words. Each role is taken at its first place after the one
 * before; for a question of "is there such a subsequence" that loses
 * nothing, and it is one pass.
 */
function reachesScheduler(words: readonly Word[], daemonCommandLine: string): string | null {
	const n = words.length
	const find = (from: number, test: (w: Word) => boolean): number => {
		for (let i = from; i < n; i++) if (test(words[i] as Word)) return i
		return -1
	}
	const named = (name: string) => (w: Word) =>
		w.wild ? w.text.includes(name) : commandName(w.text) === name
	const namesNamzu = (w: Word) => w.wild || w.text.includes('namzu')

	// systemctl <verb> <unit>
	const systemctl = find(0, named('systemctl'))
	if (systemctl >= 0) {
		if (find(systemctl + 1, (w) => !w.wild && SYSTEMCTL_VERBS_ALONE.has(w.text)) >= 0)
			return 'stops every service, the scheduler with them'
		const verb = find(systemctl + 1, (w) => w.wild || SYSTEMCTL_VERBS_WITH_UNIT.has(w.text))
		// systemctl matches unit names against a glob.
		if (verb >= 0 && find(verb + 1, (u) => namesNamzu(u) || /[*?[]/.test(u.text)) >= 0)
			return "stops or disables the scheduler's service"
	}

	// launchctl <verb> <label or plist>
	const launchctl = find(0, named('launchctl'))
	if (launchctl >= 0) {
		const verb = find(launchctl + 1, (w) => w.wild || LAUNCHCTL_VERBS.has(w.text))
		if (verb >= 0 && find(verb + 1, namesNamzu) >= 0) return "removes the scheduler's launchd agent"
	}

	// schtasks, whose switches come in any order.
	const schtasks = find(0, named('schtasks'))
	if (schtasks >= 0) {
		const rest = words.slice(schtasks + 1)
		if (rest.some((w) => w.wild || SCHTASKS_SWITCH.test(w.text)) && rest.some(namesNamzu))
			return "deletes, changes or ends the scheduler's task"
	}

	// pkill / killall: a pattern that could match the daemon's process.
	const killer = find(0, (w) => named('pkill')(w) || named('killall')(w))
	if (killer >= 0) {
		const kills = "has a pattern that could match the scheduler's process"
		const full = words
			.slice(killer + 1)
			.some((w) => /^-[a-z]*f/.test(w.text) || w.text === '--full')
		for (let i = killer + 1; i < n; i++) {
			const w = words[i] as Word
			if (w.wild) return kills
			if (w.text.startsWith('-')) continue
			if (/[.*+?^$|()[\]{}\\]/.test(w.text)) return kills
			if (w.text.includes('namzu') || w.text.includes('schedul')) return kills
			if ('node'.includes(w.text) || (full && daemonCommandLine.includes(w.text))) return kills
		}
	}

	// A D-Bus call to systemd naming the unit.
	const dbus = find(0, (w) => DBUS_TOOLS.has(commandName(w.text)))
	if (dbus >= 0 && find(dbus + 1, namesNamzu) >= 0) return 'calls systemd about a namzu unit'

	// The CLI, by name (`namzu`, a path to it, `npx @namzu/cli`) or through
	// its entry script or a JavaScript runtime: `schedule` and then anything
	// but a read-only verb.
	const strong = find(0, (w) => commandName(w.text) === 'namzu' || w.text.includes('@namzu/cli'))
	const weak = find(
		0,
		(w) => CLI_ENTRY.test(commandName(w.text)) || JS_RUNTIMES.has(commandName(w.text)),
	)
	// After the CLI's own name, a word that expands may be `schedule stop`.
	if (strong >= 0 && find(strong + 1, (w) => w.wild) >= 0)
		return 'passes the CLI a word that expands at runtime, which could be a `schedule` subcommand'
	const cli = strong < 0 ? weak : weak < 0 ? strong : Math.min(strong, weak)
	if (cli >= 0) {
		for (let i = cli + 1; i < n; i++) {
			if ((words[i] as Word).text !== 'schedule' || (words[i] as Word).wild) continue
			const verb = words[i + 1]
			if (verb === undefined) continue
			if (verb.wild) return 'runs a `schedule` subcommand that expands at runtime'
			if (!READ_ONLY_VERBS.includes(verb.text))
				return `runs \`schedule ${verb.text}\`, ${NOT_READ_ONLY}`
		}
	}
	return null
}

/**
 * Whether a command runs text the lexer did not read as commands — a shell
 * the lexer did not follow, an interpreter, `xargs`, `sudo -s`, `env -S` —
 * and if so which, in words.
 */
function runsUnreadText(command: ShellCommand): string | null {
	const words = command.words
	const head = command.assignments
	const names = words.map((w) => (w.expands ? '' : commandName(w.value)))
	// The shell at the head whose `-c` payload the lexer read, and `busybox`
	// in front of it: exactly the lexer's own decision. Any other shell —
	// `powershell -c`, `fish -c`, `bash.exe -c`, one given a script — runs
	// text the lexer never read, whatever its options look like.
	const nested = nestedShellCommand(words.slice(head))
	const readTo =
		nested !== null && 'payload' in nested
			? head + (commandName((words[head] as ShellWord).value) === 'busybox' ? 1 : 0)
			: -1
	for (let i = 0; i < words.length; i++) {
		const name = names[i] as string
		if (name === '') continue
		const program = shown((words[i] as ShellWord).value)
		if (INTERPRETERS.test(name)) return `${program} runs text as code`
		if (i === head && name === '.') return '`.` runs a file as commands'
		if (SHELLS.has(name) && !(i >= head && i <= readTo))
			return `${program} runs commands the floor does not read`
	}
	for (const [program, option] of Object.entries(STRING_OPTIONS)) {
		const flag = words.find((w) => !w.expands && option.test(w.value))
		if (names.includes(program) && flag !== undefined)
			return `\`${program} ${flag.value}\` runs a string as commands`
	}
	return null
}

/**
 * `powershell`/`pwsh`, anywhere in the command, given `-EncodedCommand` (or
 * an unambiguous prefix of it): the program word and the flag, or null.
 */
function encodedCommandCall(
	command: ShellCommand,
): { readonly program: ShellWord; readonly flag: ShellWord } | null {
	const words = command.words
	for (let i = command.assignments; i < words.length; i++) {
		const word = words[i] as ShellWord
		if (word.expands || !POWERSHELL_NAMES.has(commandName(word.value))) continue
		const flag = words.slice(i + 1).find((w) => !w.expands && ENCODED_COMMAND_FLAG.test(w.value))
		if (flag !== undefined) return { program: word, flag }
	}
	return null
}

// ---------------------------------------------------------------------------
// Paths

/**
 * `text` with `\` read as `/`, empty and `.` segments dropped and `..`
 * applied, the way the kernel resolves a path (symbolic links aside). Applied
 * to any text, not only a path: a segment that is not a path's is kept.
 */
function normalize(text: string): string {
	const out: string[] = []
	const parts = text.replace(/\\/g, '/').split('/')
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] as string
		if (part === '' && i > 0) continue
		if (part === '.') continue
		if (part === '..') {
			const last = out.at(-1)
			if (last === '') continue // at the root
			if (last !== undefined && last !== '..') {
				out.pop()
				continue
			}
		}
		out.push(part)
	}
	if (out.length === 1 && out[0] === '') return '/'
	return out.join('/')
}

function isAbsolute(path: string): boolean {
	return path.startsWith('/') || path.startsWith('\\') || /^[a-z]:[\\/]/.test(path)
}

function join(dir: string, rel: string): string {
	return normalize(`${dir}/${rel}`)
}

/** Linear-time search for `home` in normalized `text`, as a whole path. */
function containsPath(text: string, home: string): boolean {
	let at = text.indexOf(home)
	while (at >= 0) {
		const before = at === 0 ? '' : (text[at - 1] as string)
		const after = text[at + home.length] ?? ''
		if (!NAME_CHAR.test(before) && !NAME_CHAR.test(after)) return true
		at = text.indexOf(home, at + 1)
	}
	return false
}

/**
 * The directories a command may run in: every one the line spells out, and
 * whether a `cd` may have gone somewhere else. A relative path is checked
 * against each; one that could be anywhere is not denied for that alone.
 */
interface Cwd {
	readonly dirs: readonly string[]
	readonly unknown: boolean
}

/** No directory known: a relative path is checked against none. */
const NOWHERE: Cwd = { dirs: [], unknown: true }

/** Values a variable may hold at a use, or `unknown` among them. */
type Alternatives = { readonly values: readonly string[]; readonly unknown: boolean }

const UNKNOWN: Alternatives = { values: [], unknown: true }

/** How many ways a word may be spelled out before the floor stops trying and denies. */
const MAX_ALTERNATIVES = 64

/** One spelling of a word with its known expansions done. */
interface Spelling {
	/** Lower-cased text up to the first unknown expansion or glob. */
	readonly known: string
	/** Where the known text stops: the end, a glob, or an unknown expansion. */
	readonly stop: 'end' | 'glob' | 'unknown'
	/** Lower-cased text after the stop. */
	readonly rest: string
}

class TooMany extends Error {}

// ---------------------------------------------------------------------------
// The Windows browser's profiles

/**
 * The segments that end the path of the Windows browser's profile root,
 * `%LOCALAPPDATA%\namzu`. The user folder above them is not known here (a
 * run may name any user's), so these are what a path is matched on.
 */
const PROFILE_SEGMENTS = ['appdata', 'local', 'namzu'] as const
const PROFILE_TAIL = PROFILE_SEGMENTS.join('/')
/** What `%LOCALAPPDATA%` and `$LOCALAPPDATA` stand for in the checks below. */
const LOCAL_APP_DATA = 'c:/users/%username%/appdata/local'

/**
 * Lower-cased `text` with `%LOCALAPPDATA%`, `$env:LOCALAPPDATA`,
 * `${env:LOCALAPPDATA}`, `$LOCALAPPDATA` and `${LOCALAPPDATA}` spelled out.
 */
function spellLocalAppData(text: string): string {
	return text.includes('localappdata')
		? text.replace(/%localappdata%|\$\{?(?:env:)?localappdata(?![a-z0-9_])\}?/g, LOCAL_APP_DATA)
		: text
}

/** Whether normalized, lower-cased text names the profile root or a path in it. */
function namesProfile(text: string): boolean {
	return containsPath(text, PROFILE_TAIL)
}

/** Characters that stand for text the floor does not know: a glob or an expansion. */
const WILD = /[*?[$`{]/
const WILD_RUN = /\$\{[^}]*\}?|\$[a-z0-9_]*|`[^`]*`?|\[[^\]]*\]?|[*?{}]/

/** Whether one path segment with wildcards in it could be `name`: its literal pieces, in order. */
function mayBe(segment: string, name: string): boolean {
	if (!WILD.test(segment)) return segment === name
	const pieces = segment.split(WILD_RUN)
	const first = pieces[0] as string
	const last = pieces.at(-1) as string
	if (!name.startsWith(first) || !name.endsWith(last)) return false
	let at = first.length
	for (const piece of pieces.slice(1, -1)) {
		const found = name.indexOf(piece, at)
		if (found < 0) return false
		at = found + piece.length
	}
	return at <= name.length - last.length
}

/**
 * Whether a normalized path with wildcards in it could run through
 * `appdata/local/namzu`. Three segments of nothing but wildcards are not
 * enough: `ls` of three globbed levels in a project is not a way into a Windows profile.
 */
function mayNameProfile(text: string): boolean {
	const segments = text.split('/')
	for (let i = 0; i + PROFILE_SEGMENTS.length <= segments.length; i++) {
		const run = segments.slice(i, i + PROFILE_SEGMENTS.length)
		if (!run.every((segment, k) => mayBe(segment, PROFILE_SEGMENTS[k] as string))) continue
		if (run.some((segment) => segment.split(WILD_RUN).some((piece) => piece !== ''))) return true
	}
	return false
}

/**
 * Whether a path stops short inside the profile root's last name
 * (`…/AppData/Local/nam`), to be finished by an expansion elsewhere.
 */
function endsShortOfProfile(path: string): boolean {
	const segments = path.split('/')
	const n = segments.length
	const last = segments[n - 1] as string
	return (
		n >= 3 &&
		segments[n - 3] === 'appdata' &&
		segments[n - 2] === 'local' &&
		last !== '' &&
		last !== 'namzu' &&
		'namzu'.startsWith(last)
	)
}

/** What the tripwire found in text the floor could not read, and why it matters. */
interface Trip {
	/** The text that matched, as found. */
	readonly token: string
	/** What it can reach, in words. */
	readonly what: string
	/** How to find it in a decoded word, when a substring search would find it elsewhere. */
	readonly pattern?: RegExp
}

/** `schedule` as a command word: not a path segment, not a longer word (`scheduled`). */
const SCHEDULE_WORD = /(?:^|[\s,;([{|&=])schedule(?=$|[\s,;)\]}|&])/g
/** The CLI, the runtimes it can be started through, or its entry script, as a word. */
const CLI_IN_TEXT =
	/namzu|bin\.[cm]?js|(?:^|[^a-z0-9_-])(?:node|nodejs|npx|pnpx|bunx|bun|deno|tsx|ts-node|npm|pnpm|yarn)(?![a-z0-9_-])/
/** An expansion that could hold the CLI's name or path: `$X`, a backtick, `%X%`. */
const EXPANSION_IN_TEXT = /[$`]|%[a-z_][a-z0-9_]*%/
/** The scheduler service's names: the unit and task (`namzu-scheduler…`), the launchd label. */
const SERVICE_NAME_IN_TEXT = /namzu-scheduler[a-z0-9._-]*|com\.namzu\.[a-z0-9._-]*/
/** Tools that stop, change or remove a service or a scheduled task. */
const SERVICE_TOOL_IN_TEXT =
	/(?:^|[^a-z0-9_-])(systemctl|launchctl|schtasks|busctl|dbus-send|gdbus|(?:stop|disable|unregister|set)-scheduledtask|schedule\.service)(?![a-z0-9_-])/
/** `pkill` and `killall` match a process by pattern, and the scheduler is a `node` process. */
const PROCESS_KILLER_IN_TEXT = /(?:^|[^a-z0-9_-])(pkill|killall)(?![a-z0-9_-])/
/** `NAMZU_HOME` by name, in any shell's or language's spelling of a variable. */
const HOME_VARIABLE_IN_TEXT = /(?:^|[^a-z0-9_])namzu_home(?![a-z0-9_])/
/** The Windows profile root's parent, spelled as a variable or a known-folder name. */
const LOCAL_APP_DATA_IN_TEXT =
	/localappdata|localapplicationdata|(?:^|[^a-z0-9])appdata(?![a-z0-9])/
/** `namzu` as a path segment or a string of its own. */
const NAMZU_SEGMENT = /(?:^|[^a-z0-9_.-])namzu(?![a-z0-9_.-])/

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A `schedule` subcommand that is not read-only, in one text, or null. */
function scheduleSubcommand(text: string): string | null {
	for (const match of text.matchAll(SCHEDULE_WORD)) {
		const after = text.slice((match.index ?? 0) + match[0].length)
		const verb = /^[\s,]*([a-z0-9][a-z0-9_-]*)/.exec(after)?.[1]
		if (verb !== undefined && READ_ONLY_VERBS.includes(verb)) continue
		return verb === undefined ? 'schedule' : `schedule ${verb}`
	}
	return null
}

class Floor {
	private readonly home: string
	/** NAMZU_HOME as the operator wrote it, for a refusal. */
	private readonly homeShown: string
	private readonly homeCore: string
	/** NAMZU_HOME's last segment, and the default's (`.namzu`), as path segments in text. */
	private readonly homeSegments: readonly { readonly name: string; readonly pattern: RegExp }[]
	private readonly userHome: string
	private readonly folders: readonly string[]
	private readonly daemonCommandLine: string
	private readonly builtinCommands: ReadonlyMap<string, string>

	constructor(options: FloorOptions) {
		this.home = normalize(lower(options.namzuHome))
		this.homeShown = options.namzuHome
		this.userHome = normalize(lower(options.userHome))
		this.folders = (options.folders ?? []).map((f) => normalize(lower(f)))
		const last = this.home.split('/').at(-1) ?? ''
		this.homeCore = last.replace(/^\.+/, '')
		// A dotted name (`.namzu`) is a path segment wherever it stands; an
		// undotted one only after a slash, or the product's name would be one.
		this.homeSegments = [...new Set(['.namzu', last])]
			.filter((name) => name.replace(/^\.+/, '').length >= 3)
			.map((name) => ({
				name,
				pattern: name.startsWith('.')
					? new RegExp(`(?:^|[^a-z0-9_.-])${escapeRegExp(name)}(?![a-z0-9_.-])`)
					: new RegExp(`[/\\\\]${escapeRegExp(name)}(?![a-z0-9_.-])`),
			}))
		this.builtinCommands = builtinCommandArguments()
		this.daemonCommandLine = lower(
			options.daemonCommandLine ?? `${process.execPath} ${process.argv[1] ?? ''} schedule daemon`,
		)
	}

	/** What the floor protects, as a refusal names it. */
	private protectedWords(what: FloorProtected): string {
		return what === 'NAMZU_HOME'
			? `NAMZU_HOME (${this.homeShown})`
			: "the Windows browser's profile folder (%LOCALAPPDATA%\\namzu)"
	}

	/** Why the floor denies the call and what matched, or null when it does not. */
	find(call: AuthorizationPredicateCall): FloorFinding | null {
		const argument = call.toolDef
			? commandArgumentOf(call.toolDef)
			: this.builtinCommands.get(call.toolName)
		const input = call.toolInput
		let line: string | undefined
		if (argument !== undefined && typeof input === 'object' && input !== null) {
			const value = (input as Record<string, unknown>)[argument]
			if (typeof value === 'string') line = value
		}
		try {
			const named = this.stringsName(input, line)
			if (named !== null)
				return {
					reason: `names ${named.what}`,
					detail: `${named.where} names ${this.protectedWords(named.what)}`,
				}
			if (line !== undefined) return this.lineVerdict(line, call.commandDialect)
			return null
		} catch (error) {
			if (error instanceof TooMany)
				return {
					reason: 'too many spellings',
					detail: `a word in the command can be spelled more than ${MAX_ALTERNATIVES} ways once its variables are filled in, and the floor refuses rather than try them all`,
				}
			throw error
		}
	}

	// ---- any tool -----------------------------------------------------------

	/** Every string in the input but the command line, searched as text. */
	private stringsName(
		input: unknown,
		line: string | undefined,
	): { readonly what: FloorProtected; readonly where: string } | null {
		const stack: { readonly value: unknown; readonly at: string; readonly key?: boolean }[] = [
			{ value: input, at: '' },
		]
		let skipped = false
		while (stack.length > 0) {
			const { value, at, key } = stack.pop() as (typeof stack)[number]
			if (typeof value === 'string') {
				if (!skipped && value === line) {
					skipped = true
					continue
				}
				const where = key
					? `the argument name ${shown(value)}`
					: at === ''
						? 'the input'
						: `the \`${at}\` argument`
				if (this.textNamesHome(value)) return { what: 'NAMZU_HOME', where }
				if (textNamesProfile(value)) return { what: 'the browser profiles', where }
			} else if (Array.isArray(value)) {
				value.forEach((each, i) => stack.push({ value: each, at: `${at}[${i}]` }))
			} else if (value !== null && typeof value === 'object') {
				for (const [name, each] of Object.entries(value)) {
					const path = at === '' ? name : `${at}.${name}`
					stack.push({ value: name, at: path, key: true }, { value: each, at: path })
				}
			}
		}
		return null
	}

	/**
	 * NAMZU_HOME in free text: as a path, through `~`, `$HOME`, `${HOME}` or
	 * `$NAMZU_HOME`, in any letter case; and again with quotes and
	 * backslashes dropped, as a shell would drop them.
	 */
	textNamesHome(text: string): boolean {
		const plain = lower(text)
		const unquoted = plain
			.replace(/\\\n/g, '')
			.replace(/\$(?=["'])/g, '')
			.replace(/["'\\]/g, '')
		for (const variant of [plain, unquoted]) {
			if (/\$\{?[!#]?namzu_home(?![a-z0-9_])/.test(variant)) return true
			const spelled = variant
				.replace(/\$\{home\}|\$home(?![a-z0-9_])/g, this.userHome)
				.replace(/(^|[\s"'=:(<>|;&,`])~[a-z0-9._-]*(?=[/\\]|$|[\s"'])/g, `$1${this.userHome}`)
			if (containsPath(normalize(spelled), this.home)) return true
		}
		return false
	}

	// ---- a command line -----------------------------------------------------

	private lineVerdict(line: string, dialect: 'bash' | 'sh', depth = 0): FloorFinding | null {
		// A line for a shell that may be bash or a POSIX shell is read both
		// ways, and denied if either reading denies it.
		const readings =
			dialect === 'bash'
				? [lexShellCommandLine(line, { dialect: 'bash' })]
				: [
						lexShellCommandLine(line, { dialect: 'sh' }),
						lexShellCommandLine(line, { dialect: 'bash' }),
					]
		const catalogue = /textdomain/i.test(line)
		const loops = /\b(?:while|until|for|select)\b/.test(line)
		let unaccounted: { readonly reason: FloorReason; readonly why: string } | null = null
		for (const reading of readings) {
			const finding = this.readingVerdict(reading, catalogue, loops)
			if (finding !== null) return finding
			if (reading.opaque) {
				unaccounted ??= {
					reason: 'opaque line mentions a protected name',
					why: `the floor cannot read the line (${reading.reasons[0] ?? 'a construct it does not model'})`,
				}
				continue
			}
			for (const command of reading.commands) {
				const unread = unreadCommand(command)
				if (unread === null) continue
				unaccounted ??= { reason: 'unread text mentions a protected name', why: unread }
				break
			}
		}
		if (unaccounted === null) return null
		const trip = this.tripwire(line, readings)
		if (trip !== null)
			return {
				reason: unaccounted.reason,
				detail: `${unaccounted.why}, and it holds ${shown(trip.token)} (${trip.what})${whereIn(readings, trip.pattern ?? trip.token)}`,
			}
		// Text a program may run as a command line — an argument (`echo '…' |
		// sh`, `sudo bash -c '…'`), a here-string, a here-document's body —
		// is read as one, decoded, so what the tripwire looks for cannot hide
		// behind escapes that only the inner shell undoes.
		if (depth < MAX_TEXT_DEPTH)
			for (const text of fedTexts(readings)) {
				const inner = this.lineVerdict(text, 'bash', depth + 1)
				if (inner !== null)
					return {
						reason: unaccounted.reason,
						detail: `${unaccounted.why}, and read as a command line, ${shown(text)}: ${inner.detail}`,
					}
			}
		return null
	}

	/**
	 * The tripwire, for a line the lexer could not account for: something in
	 * its text that can reach what the floor protects, or null. Read in the
	 * line as written, with quotes and expansion marks dropped (and once more
	 * with backslashes dropped too), and in every word the lexer decoded:
	 *
	 * - `NAMZU_HOME` by name (`$NAMZU_HOME`, `%NAMZU_HOME%`,
	 *   `os.environ['NAMZU_HOME']`), its last segment as a path segment
	 *   (`.namzu`, always), or a path into it;
	 * - the Windows browser's profile folder, as a path, or `LOCALAPPDATA` (or
	 *   `AppData`) with `namzu` as a segment or a string of its own;
	 * - the scheduler service's name (`namzu-scheduler…`, `com.namzu.…`);
	 * - a service tool (`systemctl`, `launchctl`, `schtasks`, the D-Bus tools,
	 *   PowerShell's `*-ScheduledTask`) with `namzu` or a glob in the text,
	 *   `systemctl isolate` or `exit`; `pkill` or `killall` anywhere, because
	 *   a pattern can match the scheduler's `node` process without naming it;
	 * - `schedule` as a command word followed by anything but a read-only
	 *   verb, when the text also names the CLI (`namzu`, `@namzu/cli`,
	 *   `bin.js`, a JavaScript runtime) or holds an expansion that could.
	 *
	 * Nothing else: the product's name in a string (`MessageBox::Show('Namzu:
	 * scheduled job running')`) reaches none of them.
	 */
	private tripwire(line: string, readings: readonly ShellLexResult[]): Trip | null {
		const plain = lower(line).replace(/\\\n/g, '')
		const unquoted = plain.replace(/["'$`]/g, '')
		const squashed = unquoted.replace(/\\/g, '')
		const decoded = readings
			.flatMap((r) => r.commands.flatMap((c) => c.words.map((w) => lower(w.value))))
			.join(' ')
		const texts = [squashed, unquoted, decoded]
		const first = (pattern: RegExp): string | null => {
			for (const text of texts) {
				const match = pattern.exec(text)
				if (match) return match[1] ?? match[0].replace(/^[^a-z0-9%.]+/, '')
			}
			return null
		}

		// NAMZU_HOME.
		if (HOME_VARIABLE_IN_TEXT.test(plain) || first(HOME_VARIABLE_IN_TEXT) !== null)
			return { token: 'NAMZU_HOME', what: 'the NAMZU_HOME variable' }
		for (const { name, pattern } of this.homeSegments)
			if (texts.some((text) => pattern.test(text)))
				return { token: name, what: "NAMZU_HOME's folder name", pattern }
		if (this.textNamesHome(line) || this.textNamesHome(decoded))
			return { token: this.homeShown, what: 'a path into NAMZU_HOME' }

		// The Windows browser's profiles.
		if (textNamesProfile(line) || textNamesProfile(decoded))
			return {
				token: '%LOCALAPPDATA%\\namzu',
				what: "a path into the Windows browser's profile folder",
			}
		const appData = first(LOCAL_APP_DATA_IN_TEXT)
		if (appData !== null && texts.some((text) => NAMZU_SEGMENT.test(text)))
			return {
				token: `${appData} … namzu`,
				what: "together, the Windows browser's profile folder",
			}

		// The service.
		const service = first(SERVICE_NAME_IN_TEXT)
		if (service !== null) return { token: service, what: "the scheduler service's name" }
		const tool = first(SERVICE_TOOL_IN_TEXT)
		if (tool !== null) {
			if (texts.some((text) => text.includes('namzu')))
				return { token: `${tool} … namzu`, what: 'a service tool with a namzu name' }
			if (plain.includes('*'))
				return { token: `${tool} … *`, what: 'a service tool with a pattern that can match it' }
			if (tool === 'systemctl') {
				const all = first(/(?:^|\s)(isolate|exit)(?![a-z0-9_-])/)
				if (all !== null) return { token: `systemctl ${all}`, what: 'which stops every service' }
			}
		}
		const killer = first(PROCESS_KILLER_IN_TEXT)
		if (killer !== null)
			return {
				token: killer,
				what: 'which kills by pattern, and the scheduler is a node process a pattern can match',
			}

		// The CLI's `schedule` subcommands.
		// `$'…'` and `$"…"` are quotes, not expansions.
		const cli =
			texts.some((text) => CLI_IN_TEXT.test(text)) ||
			EXPANSION_IN_TEXT.test(plain.replace(/\$(?=['"])/g, ''))
		if (cli)
			for (const text of [squashed, decoded]) {
				const subcommand = scheduleSubcommand(text)
				if (subcommand !== null) return { token: subcommand, what: NOT_READ_ONLY }
			}
		return null
	}

	private readingVerdict(
		reading: ShellLexResult,
		catalogue: boolean,
		loops: boolean,
	): FloorFinding | null {
		for (const command of reading.commands) {
			const encoded = encodedCommandCall(command)
			if (encoded !== null)
				return {
					reason: 'encoded command cannot be read at all',
					detail: `${shown(encoded.program.value)} ${shown(encoded.flag.value)} runs a base64-encoded script the floor cannot read at all, so it is refused outright whatever it decodes to; use -Command '<literal text>' instead`,
				}
		}
		for (const command of reading.commands) {
			const does = reachesScheduler(wordsOf(command, catalogue), this.daemonCommandLine)
			if (does !== null)
				return {
					reason: 'scheduler command',
					detail: `${shown(command.words.map((w) => w.text).join(' '))} ${does}`,
				}
		}

		const variables = this.assignments(reading)
		const expanding = (w: ShellWord) => w.expands && !localeOnly(w.value, catalogue)
		const expands =
			reading.commands.some((c) => c.words.some(expanding)) ||
			reading.redirections.some((r) => expanding(r.target)) ||
			reading.compoundWords.some(expanding)
		// An assignment on its own reaches no program, and every use of the
		// variable is spelled out with its value. One that is exported, or
		// could be, is checked where it stands.
		const exported = reading.commands.some((c) =>
			c.words.some((w) => !w.expands && EXPORTING.has(commandName(w.value))),
		)
		const names = (what: FloorProtected) => `names ${this.protectedWords(what)}`
		const cwd = new Directories(this.folders)
		// In a loop, a `cd` late in the body applies to the next pass's first
		// command: every command gets every directory the line can reach.
		if (loops)
			for (const command of reading.commands)
				cwd.after(command, (target) => this.spell(target, variables, cwd.current()), this.userHome)
		const seen = new Set<ShellRedirection>()
		for (const command of reading.commands) {
			const here = cwd.current()
			const check = (word: ShellWord) => this.wordNames(word, variables, here, expands)
			const standalone = command.words.length === command.assignments && !exported
			for (const [i, word] of command.words.entries()) {
				if (standalone && i < command.assignments) continue
				const named = check(word)
				if (named !== null)
					return {
						reason: `word names ${named}`,
						detail: `the argument ${shown(word.text)} ${names(named)}`,
					}
				// `X=~/.namzu` as an argument, or exported: the value on its own.
				const assigned = assignedValue(word)
				const value = assigned ? check(assigned.word) : null
				if (value !== null)
					return {
						reason: `assigned value names ${value}`,
						detail: `the value assigned in ${shown(word.text)} ${names(value)}`,
					}
			}
			for (const redirection of command.redirections) {
				seen.add(redirection)
				const named = redirectsTo(redirection) ? check(redirection.target) : null
				if (named !== null)
					return {
						reason: `redirection names ${named}`,
						detail: `the redirection ${shown(`${redirection.operator} ${redirection.target.text}`)} ${names(named)}`,
					}
			}
			cwd.after(command, (target) => this.spell(target, variables, cwd.current()), this.userHome)
		}
		// A compound command's redirections and words belong to no one
		// command: every directory the line can be in applies.
		const anywhere = cwd.current()
		const check = (word: ShellWord) => this.wordNames(word, variables, anywhere, expands)
		for (const redirection of reading.redirections) {
			if (seen.has(redirection) || !redirectsTo(redirection)) continue
			const named = check(redirection.target)
			if (named !== null)
				return {
					reason: `redirection names ${named}`,
					detail: `the redirection ${shown(`${redirection.operator} ${redirection.target.text}`)} ${names(named)}`,
				}
		}
		for (const word of reading.compoundWords) {
			const named = check(word)
			if (named !== null)
				return {
					reason: `loop or case word names ${named}`,
					detail: `the loop or case word ${shown(word.text)} ${names(named)}`,
				}
		}
		return null
	}

	/** Literal values the line assigns to each variable (`X=…`, `export X=…`). */
	private assignments(reading: ShellLexResult): Map<string, Alternatives> {
		const found = new Map<string, Set<string>>()
		const unknown = new Set<string>()
		const record = (word: ShellWord) => {
			const value = assignedValue(word)
			if (value === null) return
			const { name, append } = value
			const spellings = append ? [] : this.spell(value.word, new Map(), NOWHERE)
			if (spellings.length === 0 || spellings.some((s) => s.stop !== 'end')) {
				unknown.add(name)
				return
			}
			const values = found.get(name) ?? new Set<string>()
			for (const s of spellings) values.add(s.known)
			found.set(name, values)
		}
		for (const command of reading.commands) {
			command.words.slice(0, command.assignments).forEach(record)
			const head = command.words[command.assignments]
			if (
				head &&
				!head.expands &&
				['export', 'declare', 'typeset', 'local', 'readonly'].includes(head.value)
			)
				command.words.slice(command.assignments + 1).forEach(record)
		}
		const out = new Map<string, Alternatives>()
		for (const [name, values] of found) {
			if (values.size > 8) throw new TooMany()
			// The environment's value is possible too: a use may come before the assignment.
			out.set(name, { values: [...values], unknown: true })
		}
		for (const name of unknown) if (!out.has(name)) out.set(name, UNKNOWN)
		return out
	}

	/**
	 * A word's value with `~`, `$HOME`, `${HOME}`, `$NAMZU_HOME`, `$PWD` and
	 * the line's own literal assignments spelled out, one spelling per
	 * combination of the values each may hold.
	 */
	private spell(
		word: ShellWord,
		variables: ReadonlyMap<string, Alternatives>,
		cwd: Cwd,
	): Spelling[] {
		if (!word.expands) return [{ known: lower(word.value), stop: 'end', rest: '' }]
		const value = unlocale(word.value.replace(/\\\n/g, ''))
		// Bash expands a tilde only when nothing between it and the first
		// unquoted `/` is quoted: `~/x` does, `"~"/x`, `~"/x"` and `~\/x` do not.
		const raw = word.text.replace(/\\\n/g, '')
		const tildeFirst = /^~[A-Za-z0-9._-]*(?:\/|$)/.test(raw)
		const tildeAssigned =
			/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(raw) && /[=:]~[A-Za-z0-9._-]*(?:[/:]|$)/.test(raw)
		let open = ['']
		const out: Spelling[] = []
		const stopAll = (stop: Spelling['stop'], from: number) => {
			const rest = lower(value.slice(from))
			for (const known of open) out.push({ known: lower(known), stop, rest })
		}
		let i = 0
		while (i < value.length && open.length > 0) {
			const c = value[i] as string
			if (
				c === '~' &&
				((i === 0 && tildeFirst) ||
					((value[i - 1] === '=' || value[i - 1] === ':') && tildeAssigned))
			) {
				let j = i + 1
				while (j < value.length && NAME_CHAR.test(lower(value[j] as string))) j++
				if (j === value.length || value[j] === '/') {
					open = open.map((known) => known + this.userHome)
					i = j
					continue
				}
			}
			if (c === '$') {
				const simple = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})/.exec(
					value.slice(i, i + 256),
				)
				if (simple) {
					const name = (simple[1] ?? simple[2]) as string
					const alternatives: Alternatives =
						name === 'HOME'
							? { values: [this.userHome], unknown: false }
							: name === 'NAMZU_HOME'
								? { values: [this.home], unknown: false }
								: name === 'PWD'
									? { values: cwd.dirs, unknown: cwd.unknown }
									: name === 'LOCALAPPDATA'
										? localAppData(variables.get(name))
										: (variables.get(name) ?? UNKNOWN)
					i += simple[0].length
					// An unknown value ends every spelling here; a known one
					// continues each, once per value.
					if (alternatives.unknown) stopAll('unknown', i)
					const next: string[] = []
					for (const known of open) for (const v of alternatives.values) next.push(known + v)
					if (next.length + out.length > MAX_ALTERNATIVES) throw new TooMany()
					open = next
					continue
				}
				if (i + 1 < value.length) {
					stopAll('unknown', i + 1)
					return out
				}
			}
			if (c === '`' || c === '{') {
				stopAll('unknown', i + 1)
				return out
			}
			if (c === '*' || c === '?' || c === '[') {
				stopAll('glob', i)
				return out
			}
			open = open.map((known) => known + c)
			i++
		}
		stopAll('end', value.length)
		return out
	}

	private inside(path: string): boolean {
		return path === this.home || path.startsWith(this.home === '/' ? '/' : `${this.home}/`)
	}

	/** The home segment right below `dir`, when `dir` is an ancestor of NAMZU_HOME. */
	private belowAncestor(dir: string): string | null {
		const prefix = dir === '/' ? '/' : `${dir}/`
		if (!this.home.startsWith(prefix)) return null
		return this.home.slice(prefix.length).split('/')[0] ?? ''
	}

	/** What a word names that the floor protects, or null. */
	private wordNames(
		word: ShellWord,
		variables: ReadonlyMap<string, Alternatives>,
		cwd: Cwd,
		lineExpands: boolean,
	): FloorProtected | null {
		if (this.wordNamesHome(word, variables, cwd, lineExpands)) return 'NAMZU_HOME'
		if (this.wordNamesProfile(word, variables, cwd, lineExpands)) return 'the browser profiles'
		return null
	}

	/**
	 * The Windows browser's profiles in a word, on the same spellings and
	 * directories as NAMZU_HOME. The root is known only by its last three
	 * segments, so a word with an unknown part is denied when its segments
	 * could still read `appdata/local/namzu` and one of them is spelled out,
	 * or when an unknown expansion is followed by a `namzu` segment.
	 */
	private wordNamesProfile(
		word: ShellWord,
		variables: ReadonlyMap<string, Alternatives>,
		cwd: Cwd,
		lineExpands: boolean,
	): boolean {
		for (const spelling of this.spell(word, variables, cwd)) {
			const known = spellLocalAppData(spelling.known)
			const rest = spellLocalAppData(spelling.rest)
			// Anywhere in the word, and as a relative path from each directory.
			const bases = isAbsolute(known) ? [''] : ['', ...cwd.dirs]
			// A word with none of the root's names, no `..` and nothing unknown
			// in it cannot lead into the root from a directory outside it:
			// only a directory already inside it matters then, and joining the
			// word to every directory a line of `cd`s names is the cost.
			const inert = !/namzu|local|appdata|\.\.|[*?[$`{]/.test(known + rest)
			for (const base of bases) {
				if (inert && base !== '') {
					if (namesProfile(base)) return true
					continue
				}
				const at = (text: string) => (base === '' ? normalize(text) : join(base, text))
				if (spelling.stop === 'end') {
					const path = at(known)
					if (namesProfile(path)) return true
					if (lineExpands && endsShortOfProfile(path)) return true
					continue
				}
				// The unknown part stands for any text: `*` does, as a segment's wildcard.
				if (mayNameProfile(at(`${known}*${rest}`))) return true
			}
			// An expansion may hold slashes, and so the whole path above `namzu`.
			if (spelling.stop === 'unknown' && /(?:^|\/)namzu(?:\/|$)/.test(normalize(rest))) return true
		}
		return false
	}

	/** Whether text after an unknown expansion holds NAMZU_HOME's last segment as a path segment. */
	private restNamesHome(rest: string): boolean {
		let at = rest.indexOf(this.homeCore)
		while (at >= 0) {
			const before = at === 0 ? '' : (rest[at - 1] as string)
			const after = rest[at + this.homeCore.length] ?? ''
			if (/^[./\\]?$/.test(before) && !NAME_CHAR.test(after)) return true
			at = rest.indexOf(this.homeCore, at + 1)
		}
		return false
	}

	private wordNamesHome(
		word: ShellWord,
		variables: ReadonlyMap<string, Alternatives>,
		cwd: Cwd,
		lineExpands: boolean,
	): boolean {
		if (word.expands && /\$\{?[!#]?namzu_home(?![a-z0-9_])/i.test(word.value)) return true
		for (const spelling of this.spell(word, variables, cwd)) {
			const { known } = spelling
			// Anywhere in the word: `--config=/…/.namzu/x`, `-f/…`.
			if (containsPath(normalize(known), this.home)) return true
			const bases = isAbsolute(known) ? [''] : cwd.dirs
			for (const base of bases) {
				const path = base === '' ? normalize(known) : join(base, known)
				if (spelling.stop === 'end') {
					if (this.inside(path)) return true
					// A piece of the path, to be finished by an expansion elsewhere
					// in the line: `for p in ~/.nam; do ls ${p}zu; done`.
					if (
						lineExpands &&
						path !== '/' &&
						this.home.startsWith(path) &&
						this.home[path.length] !== '/'
					)
						return true
					continue
				}
				// Stopped at an unknown: does the known part lead into NAMZU_HOME?
				const slash = known.lastIndexOf('/')
				const partial = known.slice(slash + 1)
				const dir =
					slash < 0
						? base === ''
							? null
							: base
						: base === ''
							? normalize(known.slice(0, slash + 1) || '/')
							: join(base, known.slice(0, slash + 1))
				if (dir === null) continue
				if (this.inside(dir)) return true
				const next = this.belowAncestor(dir)
				if (next === null) continue
				if (partial === '') {
					// A glob does not match a leading dot unless it spells one.
					if (spelling.stop === 'glob' && next.startsWith('.')) continue
					return true
				}
				if (next.startsWith(partial)) return true
			}
			// After the unknown part, NAMZU_HOME's last segment as a path
			// segment: right after the expansion (`${X}namzu`, where X may end
			// in `/.`), or after a `.`, `/` or `\` (`$X/.namzu/x`). The name
			// inside other text (`$(echo namzu)`, `"$USER: namzu done"`) is not
			// a path.
			if (spelling.stop !== 'end' && this.homeCore.length >= 3 && this.restNamesHome(spelling.rest))
				return true
		}
		return false
	}
}

/** `NAME=value`, `NAME+=value` or `--opt=value`: the value as a word of its own. */
function assignedValue(
	word: ShellWord,
): { readonly name: string; readonly append: boolean; readonly word: ShellWord } | null {
	// An assignment's name and `=` are never quoted, so both spellings start
	// with them.
	const text = word.text.replace(/\\\n/g, '')
	const match = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(text)
	if (!match || !word.value.startsWith(match[0])) return null
	return {
		name: match[1] as string,
		append: match[2] === '+',
		word: {
			text: text.slice(match[0].length),
			value: word.value.slice(match[0].length),
			expands: word.expands,
			quoted: word.quoted,
		},
	}
}

/** `$LOCALAPPDATA`'s values: the profile root's parent, and whatever the line assigns it. */
function localAppData(assigned: Alternatives | undefined): Alternatives {
	return {
		values: [LOCAL_APP_DATA, ...(assigned?.values ?? [])],
		unknown: assigned?.unknown ?? false,
	}
}

/**
 * The Windows browser's profiles in free text: a path through
 * `AppData/Local/namzu` or `%LOCALAPPDATA%\namzu`, in any letter case, either
 * slash; and again with quotes and backslashes dropped, as a shell would.
 */
export function textNamesProfile(text: string): boolean {
	const plain = lower(text)
	const unquoted = plain
		.replace(/\\\n/g, '')
		.replace(/\$(?=["'])/g, '')
		.replace(/["']/g, '')
	for (const variant of [plain, unquoted])
		if (namesProfile(normalize(spellLocalAppData(variant)))) return true
	return false
}

/** Commands that export a variable, or print the environment. */
const EXPORTING = new Set([
	'export',
	'declare',
	'typeset',
	'local',
	'readonly',
	'set',
	'env',
	'printenv',
])

/** Whether a redirection names a file: not a here-document's delimiter. */
function redirectsTo(redirection: ShellRedirection): boolean {
	return redirection.operator !== '<<' && redirection.operator !== '<<-'
}

/**
 * Where a relative path may start, command by command: the job's folder and
 * every directory a `cd` or `pushd` earlier in the line names, from any of
 * those (a `cd` in a subshell or a pipeline is counted too: broader, never
 * narrower). Unknown once a `cd` goes somewhere the line does not spell out.
 */
class Directories {
	private readonly dirs: Set<string>
	private unknown = false

	constructor(folders: readonly string[]) {
		this.dirs = new Set(folders)
	}

	/** Every directory known to be possible, and whether others are. */
	current(): Cwd {
		return { dirs: [...this.dirs], unknown: this.unknown }
	}

	after(command: ShellCommand, spell: (word: ShellWord) => Spelling[], userHome: string): void {
		const words = command.words.slice(command.assignments)
		let at = 0
		while (
			at < words.length &&
			!words[at]?.expands &&
			['builtin', 'command'].includes(words[at]?.value ?? '')
		)
			at++
		const head = words[at]
		if (!head || head.expands) return
		if (head.value === 'popd') {
			this.unknown = true
			return
		}
		if (head.value !== 'cd' && head.value !== 'pushd') return
		let target = words.slice(at + 1).find((w) => w.expands || !/^-[LPe@]+$/.test(w.value))
		if (target && !target.expands && target.value === '--')
			target = words[words.indexOf(target) + 1]
		if (!target) {
			this.dirs.add(userHome)
			return
		}
		if (!target.expands && (target.value === '-' || /^[+-]\d+$/.test(target.value))) {
			this.unknown = true
			return
		}
		const from = [...this.dirs]
		for (const spelling of spell(target)) {
			if (spelling.stop !== 'end') {
				this.unknown = true
				continue
			}
			for (const dir of isAbsolute(spelling.known) ? ['/'] : from) {
				if (this.dirs.size >= 16) {
					this.unknown = true
					return
				}
				this.dirs.add(join(dir, spelling.known))
			}
		}
	}
}

/** How many levels of text-inside-text the tripwire reads. */
const MAX_TEXT_DEPTH = 3

/** Every string in the line a program could run as a command line. */
function fedTexts(readings: readonly ShellLexResult[]): string[] {
	const out = new Set<string>()
	for (const reading of readings) {
		for (const command of reading.commands)
			for (const word of command.words) {
				const text = word.expands ? unlocale(word.value) : word.value
				if (/\s|;|&|\|/.test(text)) out.add(text)
			}
		for (const redirection of reading.redirections) {
			if (redirection.body !== undefined) out.add(redirection.body)
			if (redirection.operator === '<<<') out.add(redirection.target.value)
		}
	}
	return [...out]
}

/** A command the lexer listed whose name or payload it could not read, in words, or null. */
function unreadCommand(command: ShellCommand): string | null {
	const head = command.words[command.assignments]
	if (head?.expands) return `the command's name ${shown(head.text)} expands at runtime`
	return runsUnreadText(command)
}

/** `, in the argument …` for the first word that holds `token`, or nothing. */
function whereIn(readings: readonly ShellLexResult[], token: string | RegExp): string {
	const holds =
		typeof token === 'string'
			? (text: string) => text.includes(lower(token))
			: (text: string) => token.test(text)
	for (const reading of readings)
		for (const command of reading.commands)
			for (const word of command.words)
				if (holds(lower(word.value))) return `, in the argument ${shown(word.value)}`
	return ''
}
