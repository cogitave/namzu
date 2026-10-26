/**
 * How a shell command's exit code is judged.
 *
 * Some programs use a non-zero status to answer a question rather than to
 * report a failure: `grep` exits 1 when nothing matched, `diff` exits 1 when
 * the files differ, `test` exits 1 when the condition is false. Reading those
 * as failures turns a normal answer into a red error and sends the model off
 * to "fix" it. Every other command keeps the plain rule: non-zero is a failure.
 *
 * The command is judged by the last command on its line (the one whose status
 * the shell reports), but only when nothing earlier in an `&&` chain could
 * have supplied that status: after `cd missing && grep x f` a 1 may come from
 * `cd`, so the line is judged by the plain rule.
 */

/** What an exit code means for one command line. */
export interface ExitJudgement {
	/** The command failed. */
	readonly isError: boolean
	/** A short plain sentence for a non-zero status that is not a failure. */
	readonly note?: string
}

/** Longest line the splitter reads; a longer one gets the plain rule. */
const MAX_COMMAND_CHARS = 10_000

const PLAIN_FAILURE: ExitJudgement = { isError: true }

interface Parsed {
	/** Command texts in order, with the separator that preceded each. */
	readonly segments: readonly string[]
	readonly separators: readonly string[]
}

/**
 * Cut a line at unquoted `|`, `|&`, `||`, `&&`, `;`, `&` and newlines.
 * Undefined when the line has a shape this reading does not follow (an open
 * quote, a subshell or group, a here-document): the caller then keeps the
 * plain rule, which is the safe reading.
 */
function split(command: string): Parsed | undefined {
	const segments: string[] = []
	const separators: string[] = []
	let current = ''
	let pending = ''
	let quote: '"' | "'" | null = null
	const push = (): void => {
		segments.push(current)
		separators.push(pending)
		current = ''
	}
	for (let i = 0; i < command.length; i++) {
		const ch = command.charAt(i)
		const next = command.charAt(i + 1)
		if (quote === "'") {
			if (ch === "'") quote = null
			current += ch
			continue
		}
		if (ch === '\\') {
			current += ch + next
			i += 1
			continue
		}
		if (ch === '`') {
			const end = command.indexOf('`', i + 1)
			if (end === -1) return undefined
			current += command.slice(i, end + 1)
			i = end
			continue
		}
		if (ch === '$' && (next === '(' || next === '{')) {
			const close = next === '(' ? ')' : '}'
			let depth = 0
			let j = i + 1
			for (; j < command.length; j++) {
				const c = command.charAt(j)
				if (c === next) depth += 1
				else if (c === close && --depth === 0) break
			}
			if (j >= command.length) return undefined
			current += command.slice(i, j + 1)
			i = j
			continue
		}
		if (quote === '"') {
			if (ch === '"') quote = null
			current += ch
			continue
		}
		if (ch === '"' || ch === "'") {
			quote = ch
			current += ch
			continue
		}
		if (ch === '(' || ch === ')') return undefined
		if (ch === '<' && next === '<' && command.charAt(i + 2) !== '<') return undefined
		if (ch === '>' && next === '&') {
			// `2>&1` and `>&2` are redirects, not a background `&`.
			current += ch + next
			i += 1
			continue
		}
		if (ch === '&' && command.charAt(i - 1) === '>') {
			current += ch
			continue
		}
		if (ch === '|' || ch === '&' || ch === ';' || ch === '\n') {
			let sep = ch
			if ((ch === '|' || ch === '&') && next === ch) {
				sep = ch + ch
				i += 1
			} else if (ch === '|' && next === '&') {
				sep = '|&'
				i += 1
			}
			push()
			pending = sep === '\n' ? ';' : sep
			continue
		}
		current += ch
	}
	if (quote !== null) return undefined
	push()
	// A trailing separator (`a;`) leaves an empty last segment: drop it.
	const kept: string[] = []
	const keptSeparators: string[] = []
	segments.forEach((segment, index) => {
		if (segment.trim().length === 0) return
		kept.push(segment.trim())
		keptSeparators.push(separators[index] ?? '')
	})
	return kept.length === 0 ? undefined : { segments: kept, separators: keptSeparators }
}

/**
 * Whether an earlier command in an `&&` chain could be the one whose status
 * the line ended with: the last pipeline is joined to what precedes it by `&&`.
 */
function followsAndChain(parsed: Parsed): boolean {
	let index = parsed.segments.length - 1
	// Walk back over the pipeline the last command belongs to.
	while (index > 0 && (parsed.separators[index] === '|' || parsed.separators[index] === '|&')) {
		index -= 1
	}
	return parsed.separators[index] === '&&'
}

const NO_MATCHES = 'No matches found'

const SEARCH_WORDS = new Set(['grep', 'rg', 'egrep', 'fgrep'])

/** The subcommand of a `git` line, skipping global options (`-C <dir>`, `-c <k=v>`). */
function gitSubcommand(words: readonly string[]): string | undefined {
	if (words[0] !== 'git') return undefined
	for (let i = 1; i < words.length; i++) {
		const word = words[i] as string
		if (word.startsWith('-')) {
			if (word === '-C' || word === '-c') i += 1
			continue
		}
		return word
	}
	return undefined
}

function questionNote(command: string): string | undefined {
	const words = command.trim().split(/\s+/)
	const first = words[0] ?? ''
	if (first === 'git') {
		const sub = gitSubcommand(words)
		if (sub === 'diff') return 'Files differ'
		if (sub === 'grep') return NO_MATCHES
		return undefined
	}
	if (SEARCH_WORDS.has(first)) return NO_MATCHES
	if (first === 'find') return 'Some directories were inaccessible'
	if (first === 'diff') return 'Files differ'
	if (first === 'test' || first === '[') return 'Condition is false'
	return undefined
}

/**
 * Judge a finished command's exit code.
 *
 * Exit 0 is never a failure. For `grep`, `rg`, `egrep`, `fgrep`, `find`,
 * `diff`, `test`, `[`, `git diff` and `git grep` as the last command of the
 * line, exit 1 is an answer (with a short note) and 2 or more is a failure.
 * Anything else, or a line the reading cannot follow, fails on any non-zero.
 */
export function judgeExit(command: string, exitCode: number): ExitJudgement {
	if (exitCode === 0) return { isError: false }
	if (exitCode !== 1 || command.length > MAX_COMMAND_CHARS) return PLAIN_FAILURE
	const parsed = split(command)
	if (!parsed || followsAndChain(parsed)) return PLAIN_FAILURE
	const note = questionNote(parsed.segments[parsed.segments.length - 1] as string)
	return note === undefined ? PLAIN_FAILURE : { isError: false, note }
}
