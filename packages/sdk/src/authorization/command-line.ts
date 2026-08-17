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
 * A rule that fails to match reaches the permission mode, and a run with no
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
 * - **deny** matches when ANY segment matches. One prohibited command poisons
 *   the line it rides on.
 * - **allow** matches only when EVERY segment matches, and never when the line
 *   is {@link CommandLineDecomposition.opaque}. Permission is a claim about the
 *   whole line, and a claim that cannot be checked is not granted.
 *
 * That asymmetry is the same one `refuse-do-not-degrade` describes: when the
 * analysis is uncertain, the uncertainty spends against the permissive answer.
 *
 * ## What `opaque` means
 *
 * Some lines contain text that is not the command that runs. Command
 * substitution (`$(…)`, backticks, `<(…)`) executes something whose text is
 * not in the line at all, and `eval` runs a string assembled at runtime. No
 * decomposition of the source can be a decomposition of what ran, so the line
 * is marked opaque and `allow` declines it. `deny` still tests what is visible,
 * because a deny that matches too much costs a prompt and a deny that matches
 * too little costs the thing it was written to prevent.
 *
 * ## What it deliberately does not do
 *
 * A value with no chain operator, no nested shell and nothing opaque comes back
 * as itself, byte for byte. That keeps every rule about a non-command argument
 * — a path, a number, a URL — behaving exactly as it did, and confines this
 * machinery to the case that motivated it.
 *
 * It is a decomposition, not a shell. `xargs sh -c`, a command read from a
 * file, and a shell invoked through an interpreter it does not recognise all
 * pass through as ordinary text. Each of those either denies as before or, for
 * an allow rule, fails to match every segment and so declines. The failure mode
 * is a prompt, never a silent grant.
 */

/** The commands a line runs, and whether that list can be trusted as complete. */
export interface CommandLineDecomposition {
	/**
	 * The individual commands, in source order. Never empty: a line that
	 * decomposes to nothing yields the original.
	 */
	readonly segments: readonly string[]
	/**
	 * True when the line runs something this decomposition cannot see, so
	 * `segments` is a lower bound rather than the whole story.
	 */
	readonly opaque: boolean
}

/**
 * Shells whose `-c` argument is another command line.
 *
 * Matched on the basename, so `/bin/bash` and `bash` are the same entry. An
 * interpreter absent from this list is not a hole that grants anything: its
 * payload stays inside one segment, where an allow rule fails to match it.
 */
const NESTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'busybox'])

/** Commands whose argument is code assembled at runtime. */
const RUNTIME_EVALUATORS = new Set(['eval', 'source', '.'])

/**
 * Depth and width limits.
 *
 * A line that exceeds either is reported opaque rather than truncated: a
 * shortened list of segments would read as complete to `allow`, which is the
 * one reading that must never be wrong.
 */
const MAX_DEPTH = 4
const MAX_SEGMENTS = 64

export function decomposeCommandLine(command: string): CommandLineDecomposition {
	const state: WalkState = { opaque: false, structured: false }
	const segments = split(command, state, 0)

	// The untouched-value case, kept exact. Nothing was cut and nothing was
	// unpacked, so there is no decomposition to report and the value goes back
	// as it arrived — which is what keeps a rule about a path or a URL seeing
	// the string it always saw, punctuation and surrounding space included.
	if (!state.structured) return { segments: [command], opaque: state.opaque }

	if (segments.length === 0) return { segments: [command], opaque: state.opaque }
	if (segments.length > MAX_SEGMENTS) {
		return { segments: segments.slice(0, MAX_SEGMENTS), opaque: true }
	}
	return { segments, opaque: state.opaque }
}

interface WalkState {
	opaque: boolean
	/**
	 * Whether anything was cut or unpacked. False means the value is not a
	 * command line as far as this module can tell, and it goes back untouched.
	 */
	structured: boolean
}

/**
 * Walk the line once, quote-aware, cutting at every top-level separator.
 *
 * Quote tracking is the whole reason this is not a `String.split`: `echo "a &&
 * b"` is one command that prints a literal, and a splitter that cannot tell
 * would report a second command named `b"` — inventing a segment is as wrong as
 * missing one, because `allow` requires every segment to match.
 */
function split(command: string, state: WalkState, depth: number): string[] {
	const segments: string[] = []
	let current = ''
	let quote: "'" | '"' | null = null

	const cut = (): void => {
		const trimmed = trimSegment(current)
		current = ''
		if (trimmed === '') return
		for (const piece of expand(trimmed, state, depth)) segments.push(piece)
	}

	for (let i = 0; i < command.length; i += 1) {
		const char = command[i] as string

		if (quote === "'") {
			// Single quotes suspend everything, including the backslash. This is
			// the branch that keeps `echo 'a && b'` one command.
			if (char === "'") quote = null
			current += char
			continue
		}

		if (char === '\\') {
			// An escaped separator is a literal, so both characters go through
			// untouched and the next loop never sees the separator as one.
			current += char + (command[i + 1] ?? '')
			i += 1
			continue
		}

		if (quote === '"') {
			if (char === '"') quote = null
			// Substitution is live inside double quotes, which is exactly where
			// it hides best.
			else if (isSubstitutionStart(command, i)) state.opaque = true
			current += char
			continue
		}

		if (char === "'" || char === '"') {
			quote = char
			current += char
			continue
		}

		if (isSubstitutionStart(command, i)) {
			state.opaque = true
			current += char
			continue
		}

		const separator = separatorAt(command, i)
		if (separator > 0) {
			state.structured = true
			cut()
			i += separator - 1
			continue
		}

		current += char
	}

	// An unterminated quote means the line does not parse. Whatever it runs is
	// not what this walk saw, so the caller must not treat the result as a
	// complete account.
	if (quote !== null) state.opaque = true

	cut()
	return segments
}

/**
 * Length of the separator starting at `index`, or 0.
 *
 * The redirection cases are why this is a function. `2>&1` and `&>log` contain
 * `&` and are not separators; splitting there would manufacture a segment named
 * `1`, which no allow rule matches, and a command that redirects its output
 * would stop being approvable for a reason nobody could see.
 */
function separatorAt(command: string, index: number): number {
	const char = command[index]
	const next = command[index + 1]

	if (char === '\n') return 1
	if (char === ';') return next === ';' ? 2 : 1
	if (char === '&') {
		if (next === '&') return 2
		if (next === '>') return 0
		if (command[index - 1] === '>') return 0
		return 1
	}
	if (char === '|') {
		if (next === '|') return 2
		// `|&` pipes stderr as well; still a pipe, and both sides still run.
		if (next === '&') return 2
		return 1
	}
	return 0
}

/** Whether a command substitution opens here. */
function isSubstitutionStart(command: string, index: number): boolean {
	const char = command[index]
	if (char === '`') return true
	if (char === '$' && command[index + 1] === '(') return true
	// Process substitution: `diff <(a) <(b)` runs `a` and `b`.
	if ((char === '<' || char === '>') && command[index + 1] === '(') return true
	return false
}

/**
 * Strip the grouping punctuation a split leaves behind.
 *
 * `(cd build && make)` cuts into `(cd build` and `make)`. Leaving the bracket on
 * would stop an allow rule matching a command it names, and — worse — stop a
 * deny rule matching one, since `^make` does not match `make)`.
 */
function trimSegment(segment: string): string {
	return segment
		.trim()
		.replace(/^[({\s]+/, '')
		.replace(/[)}\s]+$/, '')
}

/**
 * Turn one segment into the commands it stands for.
 *
 * A shell invoked with `-c` carries a whole second command line in an argument,
 * and that argument is where the smuggling this module exists for is easiest:
 * `bash -c "git push"` contains no separator at all, so nothing above this
 * function would have looked inside it.
 *
 * The outer segment is kept alongside the inner ones. A rule that denies the
 * interpreter itself must still fire, and for `allow` the extra segment only
 * makes the requirement stricter — which is the safe direction.
 */
function expand(segment: string, state: WalkState, depth: number): string[] {
	const words = tokenize(segment)
	const head = words[0]
	if (head === undefined) return [segment]

	if (RUNTIME_EVALUATORS.has(basename(head.text))) {
		// The argument is source text assembled elsewhere. Even when it is a
		// visible literal, what runs is decided at runtime.
		state.opaque = true
		return [segment]
	}

	if (!NESTED_SHELLS.has(basename(head.text))) return [segment]

	const flag = words.findIndex(
		(word, index) => index > 0 && word.quoted === null && word.text === '-c',
	)
	if (flag < 0) return [segment]

	const payload = words[flag + 1]
	if (payload === undefined) {
		// `bash -c` with nothing after it is either a syntax error or an
		// argument this tokenizer failed to read. Neither may be reported as
		// "there is no nested command".
		state.opaque = true
		return [segment]
	}

	if (depth + 1 >= MAX_DEPTH) {
		state.opaque = true
		return [segment]
	}

	const nested = split(payload.text, state, depth + 1)
	if (nested.length === 0) return [segment]
	state.structured = true
	return [segment, ...nested]
}

interface Word {
	readonly text: string
	/** The quote that wrapped it, or null when it was bare. */
	readonly quoted: "'" | '"' | null
}

/**
 * Split a segment into words, removing one layer of quoting.
 *
 * The quote is reported rather than discarded because `-c` must be the flag and
 * not a literal: `echo "-c"` names no nested shell, and treating its next word
 * as a command line would decompose a string that never runs.
 */
function tokenize(segment: string): Word[] {
	const words: Word[] = []
	let current = ''
	let quote: "'" | '"' | null = null
	let sawQuote: "'" | '"' | null = null
	let open = false

	const push = (): void => {
		if (open) words.push({ text: current, quoted: sawQuote })
		current = ''
		sawQuote = null
		open = false
	}

	for (let i = 0; i < segment.length; i += 1) {
		const char = segment[i] as string

		if (quote === "'") {
			// Single quotes suspend the backslash too, so this branch precedes
			// the escape below rather than sharing it.
			if (char === "'") quote = null
			else current += char
			open = true
			continue
		}

		if (char === '\\' && i + 1 < segment.length) {
			current += segment[i + 1]
			i += 1
			open = true
			continue
		}

		if (quote === '"') {
			if (char === '"') quote = null
			else current += char
			open = true
			continue
		}

		if (char === "'" || char === '"') {
			quote = char
			sawQuote = char
			open = true
			continue
		}

		if (char === ' ' || char === '\t') {
			push()
			continue
		}

		current += char
		open = true
	}

	push()
	return words
}

function basename(word: string): string {
	const cut = word.lastIndexOf('/')
	return cut < 0 ? word : word.slice(cut + 1)
}
