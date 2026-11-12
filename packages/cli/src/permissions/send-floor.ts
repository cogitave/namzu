/**
 * The send floor: a command line a model starts may not run `namzu send`.
 *
 * `namzu send <session> <words>` puts words in front of another session's model as the person's own. A
 * session's agent (or a sub-agent, or a poisoned tool result steering one) that could run it would speak
 * to another session with the person's authority. This rule refuses the command line before it runs,
 * in every permission mode, whatever any rule says: a deny from any layer wins, and this is one that no
 * layer can undo. It is the second of three layers. The first is a marker the kernel puts into the
 * environment of every process it starts for a session (`NAMZU_STARTED_BY_SESSION`, which `namzu send`
 * reads); the third is process ancestry, read by the sender and by the receiving terminal. Each covers
 * what the others miss.
 *
 * ## What it reads
 *
 * The line goes through the SDK's one shell reader (`lexShellCommandLine`), in the `bash` and `sh`
 * dialects, so quoting (`'se'nd`, `$'\x73end'`), the payload of `sh -c`, `bash -c` and the shells the
 * reader follows, `$(…)` bodies, subshells and background commands are seen as the commands they are.
 * On each command's words, in order:
 *
 * - the CLI is named by `namzu` (or a path to it, with `.exe`, `.cmd`, `.bat` or `.ps1`), by
 *   `@namzu/cli` (`npx @namzu/cli@latest`, `pnpm dlx @namzu/cli`), or by its entry script `bin`,
 *   `bin.js`, `bin.mjs`, `bin.cjs`, as `node packages/cli/dist/bin.js` runs it. Wrappers in front
 *   (`env`, `setsid`, `nohup`, `timeout`, `sudo`, `xargs`, `find -exec` …) change nothing: the scan is
 *   over every word of the command, not only its head;
 * - after the CLI, the first of `send` and `peers` decides: `send` is refused; `peers` is the
 *   agent-to-agent channel, which says what it is on the receiving side, and is left to the rules as
 *   before. A word that expands at runtime where the subcommand would stand (`namzu $X …`) could be
 *   `send`, so it is refused too;
 * - a command whose own name expands (`$(which namzu) send`, `$A $B`) followed by a literal `send`, or
 *   by another expanding word, is refused for the same reason.
 *
 * A command that only mentions the CLI as text it prints or searches (`echo`, `printf`, `grep`, `rg`,
 * `cat`, `git`, `ls` …) is not a run of it.
 *
 * ## What it cannot see through
 *
 * It is a reader of the line, not an interpreter. A line the reader cannot account for (an opaque
 * construct, `eval`, a shell reading a script or standard input, an interpreter such as `python -c`, an
 * `xargs`-style runner) is refused when its text holds the CLI and a `send` word in that order. Past
 * that it does not see: a program or script whose contents the line does not hold (`sh ./run.sh` when
 * the file says `namzu send`), a name spelled by pieces that never stand together in the line
 * (`eval "n=nam; \${n}zu se''nd"`), a copy or a link of the CLI under another name (`ln -s "$(command -v
 * namzu)" ./x && ./x send`), and any tool whose argument is not a command line. Those are stopped by
 * the marker and by process ancestry, not by this rule, and a process that hides both is the residual
 * the account boundary holds (`docs/cli/peer-messaging.md`).
 */

import {
	type AuthorizationPredicateCall,
	type AuthorizationRule,
	type ShellCommand,
	type ShellDialect,
	type ShellLexResult,
	builtinCommandArguments,
	commandArgumentOf,
	lexShellCommandLine,
	nestedShellCommand,
} from '@namzu/sdk'

/** Why the rule refused, in one plain sentence a model can act on. */
export const SEND_FLOOR_REASON =
	'a command line a session runs may not run `namzu send`: a message to another session must come from a person at their own terminal, not from a tool or an agent. It holds in every permission mode, so rewording the command will not help'

const CLI_EXTENSIONS = /\.(?:exe|cmd|bat|ps1)$/
const CLI_ENTRY = /^bin(?:\.[cm]?js)?$/

/** Programs that print, search or list text: a CLI name among their words is an argument, not a run. */
const TEXT_ONLY_HEADS = new Set([
	'echo',
	'printf',
	'grep',
	'egrep',
	'fgrep',
	'rg',
	'ag',
	'cat',
	'head',
	'tail',
	'wc',
	'diff',
	'which',
	'type',
	'man',
	'ls',
	'git',
])

/** Shells and runners that execute text the reader may not hold. */
const UNREAD_RUNNERS =
	/^(?:sh|bash|dash|zsh|ksh|ash|mksh|busybox|fish|csh|tcsh|pwsh|powershell|cmd|wsl|python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl[0-9.]*|ruby|php[0-9.]*|lua[0-9.]*|osascript|awk|gawk|mawk|nawk|sed|gsed|tclsh|expect|eval|source|\.|xargs|parallel|watch|su|runuser|ssh|script|flock|at|batch|crontab|trap)$/

/** The CLI named anywhere in text, then `send` after it. For a line the reader cannot account for. */
const CLI_THEN_SEND =
	/(?:^|[^a-z0-9_.-])(?:namzu(?:\.(?:exe|cmd|bat|ps1))?|@namzu\/cli(?:@[a-z0-9._-]+)?|bin\.[cm]?js)(?![a-z0-9_-])[\s\S]{0,400}?(?:^|[^a-z0-9_.-])send(?![a-z0-9_-])/

function lower(text: string): string {
	return text.toLowerCase()
}

/** The last path segment, lower-cased, without a Windows launcher extension. */
function commandName(value: string): string {
	const cut = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
	return lower(cut < 0 ? value : value.slice(cut + 1)).replace(CLI_EXTENSIONS, '')
}

function namesCli(value: string): boolean {
	const name = commandName(value)
	return name === 'namzu' || lower(value).includes('@namzu/cli') || CLI_ENTRY.test(name)
}

/** Why a command runs `namzu send`, in words, or null. */
function runsSend(command: ShellCommand): string | null {
	const words = command.words.slice(command.assignments)
	if (words.length === 0) return null
	const head = words[0]
	const headName = head !== undefined && !head.expands ? commandName(head.value) : ''
	if (TEXT_ONLY_HEADS.has(headName)) return null

	const cli = words.findIndex((word) => !word.expands && namesCli(word.value))
	if (cli >= 0) {
		for (let i = cli + 1; i < words.length; i++) {
			const word = words[i]
			if (word === undefined) continue
			if (word.expands)
				return 'it passes the CLI a word that expands at runtime, which could be `send`'
			const text = lower(word.value)
			if (text === 'send') return 'it runs `namzu send`'
			if (text === 'peers') return null
		}
		return null
	}
	// A program name that expands could be the CLI: `$(command -v namzu) send`, `$A $B`.
	if (head?.expands) {
		const rest = words.slice(1)
		if (rest.some((word) => !word.expands && lower(word.value) === 'send'))
			return 'its program name expands at runtime and it is followed by `send`'
		if (rest.some((word) => word.expands))
			return 'its program name and an argument expand at runtime, which could be `namzu send`'
	}
	return null
}

/** Whether a command runs text the reader did not read as commands. */
function runsUnreadText(command: ShellCommand): boolean {
	const words = command.words.slice(command.assignments)
	const nested = nestedShellCommand(words)
	if (nested !== null && 'payload' in nested) return false
	return words.some((word) => !word.expands && UNREAD_RUNNERS.test(commandName(word.value)))
}

/**
 * The line as text a program may be handed: lower-cased, with quotes and expansion marks dropped, once
 * as written, once with `\n`, `\r` and `\t` read as spaces (`printf 'a\nnamzu send'` holds a newline, not
 * an `n`) and once without backslashes (`na\mzu`, an escape only the inner shell undoes).
 */
function textVariants(line: string): readonly string[] {
	const plain = lower(line).replace(/\\\n/g, '')
	const noQuotes = plain.replace(/["'$`]/g, '')
	return [noQuotes, noQuotes.replace(/\\[nrt]/g, ' '), noQuotes.replace(/\\/g, '')]
}

function namesSendAfterCli(line: string, decoded?: string): boolean {
	return [...textVariants(line), ...(decoded === undefined ? [] : [decoded])].some((text) =>
		CLI_THEN_SEND.test(text),
	)
}

/** Why the line runs `namzu send`, or null. */
export function findSendInLine(line: string, dialect: ShellDialect = 'sh'): string | null {
	if (dialect === 'cmd') return null
	const dialects: readonly ('bash' | 'sh')[] = dialect === 'bash' ? ['bash'] : ['sh', 'bash']
	const readings: ShellLexResult[] = dialects.map((d) => lexShellCommandLine(line, { dialect: d }))
	let unaccounted = false
	for (const reading of readings) {
		for (const command of reading.commands) {
			const found = runsSend(command)
			if (found !== null) return found
			if (command.words[command.assignments]?.expands || runsUnreadText(command)) unaccounted = true
		}
		if (reading.opaque) unaccounted = true
	}
	if (!unaccounted) return null
	const decoded = readings
		.flatMap((r) => r.commands.flatMap((c) => c.words.map((w) => lower(w.value))))
		.join(' ')
	if (namesSendAfterCli(line, decoded))
		return 'the line runs text it does not hold as commands, and that text names the CLI and `send`'
	return null
}

/** The gate rule. It only denies; a call it does not match is left to the rules after it. */
export function sendFloorRule(): AuthorizationRule {
	const builtins = builtinCommandArguments()
	const find = (call: AuthorizationPredicateCall): string | null => {
		const argument = call.toolDef ? commandArgumentOf(call.toolDef) : builtins.get(call.toolName)
		const input = call.toolInput
		if (argument === undefined || typeof input !== 'object' || input === null) return null
		const line = (input as Record<string, unknown>)[argument]
		if (typeof line !== 'string') return null
		try {
			return findSendInLine(line, call.commandDialect)
		} catch {
			// A line the reader fails on is a line it cannot vouch for.
			return namesSendAfterCli(line) ? 'the line cannot be read and names `namzu send`' : null
		}
	}
	return {
		type: 'predicate',
		description: SEND_FLOOR_REASON,
		decide: (call) => (find(call) === null ? null : 'deny'),
		describe: (call) => {
			const why = find(call)
			return why === null ? null : `${SEND_FLOOR_REASON} (${why})`
		},
	}
}
