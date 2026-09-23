/**
 * Break a command line into the commands it actually runs.
 *
 * ## The hole this closes
 *
 * A pattern rule tests a regular expression against an argument's value. When
 * that value is a command line, the value and the command are not the same
 * thing: `git push origin main` is one command, and
 * `true; git push origin main` is two, of which the second is the one the rule
 * was written about. An anchored pattern sees only the first.
 *
 * Measured against the gate, with the rule from this repository's own
 * documentation (`^git push`, deny):
 *
 *     git push origin main               -> deny
 *     echo hi && git push origin main    -> did not match
 *     true; git push origin main         -> did not match
 *     bash -c "git push origin main"     -> did not match
 *
 * A rule that fails to match reaches the permission mode, and a turn with no
 * terminal resolves that to `auto`. So an operator's prohibition was bypassed
 * by typing four characters in front of it, in exactly the unattended case the
 * prohibition exists for. The `bash` tool's own description tells the model to
 * "use `&&` / `;` chaining for compound commands", so the evading form is not
 * an exotic input — it is the documented one.
 *
 * ## Why splitting alone would make things worse
 *
 * Applied naively this widens `allow` in the same motion it fixes `deny`. An
 * allow rule matching `^git status` would go on matching the first segment of
 * `git status && rm -rf ~` and hand back `allow` for the whole line. So the
 * caller must read the two decisions differently, and {@link evaluateRule}
 * does:
 *
 * - **deny** matches when ANY segment matches, or when any command's decoded
 *   words ({@link decodedCommands}) do. One prohibited command poisons the
 *   line it rides on, however it is quoted.
 * - **allow** matches only when EVERY segment matches, and never when the line
 *   is {@link CommandLineDecomposition.opaque}. Permission is a claim about the
 *   whole line, and a claim that cannot be checked is not granted.
 *
 * That asymmetry is the same one `refuse-do-not-degrade` describes: when the
 * analysis is uncertain, the uncertainty spends against the permissive answer.
 *
 * ## Where the commands come from
 *
 * One lexer, {@link lexShellCommandLine}, reads the line the way bash does and
 * is the only thing in the SDK that knows bash's quoting. This module and
 * {@link writesThroughRedirection} are views of its result. There used to be
 * three hand-written walkers here, each with its own idea of where a quote
 * ends, and every disagreement between them was a way to run a command the
 * rules never saw.
 *
 * ## What `opaque` means
 *
 * Some lines contain text that is not the command that runs. Command
 * substitution (`$(…)`, backticks, `<(…)`) executes something whose text is
 * not in the line at all, and `eval` or `source` runs a string assembled at
 * runtime. The lexer also reports a line opaque when it does not parse, or
 * contains a construct it does not model. No decomposition of the source can
 * be a decomposition of what ran, so `allow` declines it. `deny` still tests
 * what is visible, because a deny that matches too much costs a prompt and a
 * deny that matches too little costs the thing it was written to prevent.
 *
 * ## What it deliberately does not do
 *
 * A value that is one plain command comes back as itself, byte for byte. That
 * keeps every rule about a non-command argument — a path, a number, a URL —
 * behaving exactly as it did, and confines this machinery to the case that
 * motivated it.
 *
 * It is a decomposition, not a shell. `xargs sh -c`, `env git push`, a command
 * read from a file, and a shell invoked through an interpreter it does not
 * recognise all pass through as ordinary text. Each of those either denies as
 * before or, for an allow rule, fails to match every segment and so declines.
 * The failure mode is a prompt, never a silent grant.
 */

import {
	type ShellDialect,
	type ShellLexResult,
	type ShellRedirection,
	basename,
	lexShellCommandLine,
} from './shell-lexer.js'

/** The commands a line runs, and whether that list can be trusted as complete. */
export interface CommandLineDecomposition {
	/**
	 * The individual commands' source text, in the order they were read. Never
	 * empty: a line that decomposes to nothing yields the original.
	 */
	readonly segments: readonly string[]
	/**
	 * True when the line runs something this decomposition cannot see, so
	 * `segments` is a lower bound rather than the whole story.
	 */
	readonly opaque: boolean
}

/** Commands whose argument is code assembled at runtime. */
const RUNTIME_EVALUATORS = new Set(['eval', 'source', '.'])

/**
 * Width limit. A line past it is reported opaque rather than truncated: a
 * shortened list of segments would read as complete to `allow`, which is the
 * one reading that must never be wrong.
 */
const MAX_SEGMENTS = 64

/**
 * `dialect` is the shell that will run the line (see `ShellDialect`); a
 * caller that does not know passes `sh`, whose reading holds for any POSIX
 * shell.
 */
export function decomposeCommandLine(
	command: string,
	dialect: ShellDialect = 'bash',
): CommandLineDecomposition {
	const lexed = lex(command, dialect)
	let opaque = lexed.opaque
	for (const each of lexed.commands) {
		const head = each.words[each.assignments]
		if (head !== undefined && !head.expands && RUNTIME_EVALUATORS.has(basename(head.value))) {
			// The argument is source text assembled elsewhere. Even when it is a
			// visible literal, what runs is decided at runtime.
			opaque = true
		}
	}

	// A line that does not parse runs none of the text from its error on, and
	// what it ran before that is in `decodedCommands` for deny. The value goes
	// back untouched, the way a path or a URL that is not shell at all does.
	if (!lexed.complete || lexed.commands.length === 0) return { segments: [command], opaque }

	// The untouched-value case, kept exact: one command whose text is the
	// whole line. Nothing was cut and nothing was unpacked, so the value goes
	// back as it arrived — which is what keeps a rule about a path or a URL
	// seeing the string it always saw, surrounding space included.
	const only = lexed.commands[0]
	if (
		lexed.commands.length === 1 &&
		only !== undefined &&
		only.origin === 'line' &&
		only.text === command.trim()
	) {
		return { segments: [command], opaque }
	}

	const segments = lexed.commands.map((each) => each.text)
	if (segments.length > MAX_SEGMENTS)
		return { segments: segments.slice(0, MAX_SEGMENTS), opaque: true }
	return { segments, opaque }
}

/**
 * Each command's words as bash passes them (quotes removed, `$'…'` decoded),
 * joined by single spaces — and, for a command led by assignments, the same
 * without them. For `deny` only.
 *
 * A deny rule written as `^git push` must not be evaded by `'git' push`,
 * `g\it push`, `$'git' push` or `GIT_DIR=x git push`: the source text of each
 * differs from the pattern and the command that runs does not. `allow` does
 * not use these. Its subject stays the source text, so a pattern that names
 * quotes keeps meaning what its author wrote, and a decoded form can only ever
 * add a match — which for `deny` is the safe direction and for `allow` is not.
 */
export function decodedCommands(
	command: string,
	dialect: ShellDialect = 'bash',
): readonly string[] {
	const out: string[] = []
	for (const each of lex(command, dialect).commands) {
		if (each.words.length === 0) continue
		out.push(each.words.map((word) => word.value).join(' '))
		if (each.assignments > 0 && each.words.length > each.assignments) {
			out.push(
				each.words
					.slice(each.assignments)
					.map((word) => word.value)
					.join(' '),
			)
		}
	}
	return out
}

/**
 * Whether a command line sends output into a file through a shell redirection.
 *
 * A permission pattern names commands. `>`, `>>`, `>|`, `&>`, `&>>`, `<>` and
 * `>&word` open a file for writing whose path is not the command's argument,
 * so a pattern that covers `git status *` would otherwise also cover
 * `git status > ~/.bashrc`. Callers that grant on a pattern's say-so decline
 * such a line.
 *
 * Not writes: a target of `/dev/null`, descriptor duplication and closing
 * (`2>&1`, `>&2`, `>&-`), and anything quoted or escaped so that it is not an
 * operator. Anything whose target is not known before the line runs — a
 * target built from a variable, a glob or a tilde — counts as a write, and so
 * does a line that does not parse or holds a process substitution: the
 * uncertainty spends against the grant.
 */
export function writesThroughRedirection(command: string, dialect: ShellDialect = 'bash'): boolean {
	const lexed = lex(command, dialect)
	if (!lexed.complete) return true
	if (lexed.reasons.includes('process substitution')) return true
	return lexed.redirections.some(writes)
}

function writes(redirection: ShellRedirection): boolean {
	const { operator, target } = redirection
	switch (operator) {
		case '<':
		case '<&':
		case '<<':
		case '<<-':
		case '<<<':
			return false
		case '>&':
			// `>&N`, `>&N-`, `>&-` duplicate or close a descriptor. `>&word`
			// with any other word redirects both streams into that file.
			if (!target.expands && /^(?:\d+-?|-)$/.test(target.value)) return false
			return target.expands || target.value !== '/dev/null'
		default:
			return target.expands || target.value !== '/dev/null'
	}
}

/**
 * One gate evaluation tests the same line against every rule, and each rule
 * asks for it again. The last line lexed is kept so that is one lexing.
 */
let cached:
	| { readonly command: string; readonly dialect: ShellDialect; readonly result: ShellLexResult }
	| undefined

function lex(command: string, dialect: ShellDialect): ShellLexResult {
	if (cached !== undefined && cached.command === command && cached.dialect === dialect) {
		return cached.result
	}
	const result = lexShellCommandLine(command, { dialect })
	cached = { command, dialect, result }
	return result
}
