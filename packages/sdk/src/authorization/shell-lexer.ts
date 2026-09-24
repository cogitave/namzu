/**
 * One reading of a bash command line, shared by everything that authorizes
 * one.
 *
 * ## Why there is exactly one
 *
 * Permission rules decide on the commands a line runs, so something has to say
 * what those commands are. That used to be three separate walkers — one cut
 * the line into commands, one split a command into words, one looked for
 * output redirections — and each carried its own copy of bash's quoting rules.
 * Every rule added to one had to be added to the others, and every review
 * found a place where it had not been: `$'…'` first, then `$$'…'`. Each miss
 * was the same defect: two readers disagreeing about where a quote ends, so
 * one of them took a command the shell runs for quoted text. The fix for that
 * class is not a fourth copy. It is a single lexer whose output every caller
 * reads.
 *
 * ## What it reads
 *
 * The bash (5.x, non-POSIX mode) grammar, as far as authorization needs it:
 * quoting in all its forms (`'…'`, `"…"`, `\`, `$'…'` with its escapes
 * decoded, `$"…"`), line continuation, every expansion's extent (`$name`,
 * the special parameters, `${…}` with nested quotes, `$(…)`, `$((…))`,
 * `$[…]`, backticks, `<(…)` and `>(…)`), control operators, redirections
 * including here-documents (whose bodies are consumed, never read as
 * commands), comments, reserved words and compound commands (`( )`, `{ }`,
 * `if`, `while`, `until`, `for`, `select`, `case`, `[[ ]]`), and a nested
 * `bash -c '<payload>'`, whose decoded payload is read the same way.
 *
 * The result is the list of simple commands with each word as bash produces
 * it after quote removal and before expansion, plus a flag on every word whose
 * text is not its runtime value (it contains a parameter, command or
 * arithmetic expansion, a glob, a brace expansion, a tilde, or a
 * locale-dependent escape). A word without that flag is exactly the argument
 * bash passes. `packages/sdk/src/authorization/__tests__/shell-lexer-bash.test.ts`
 * checks that against the bash on the machine running the tests.
 *
 * ## Failing closed
 *
 * {@link ShellLexResult.opaque} is set when the command list is not a
 * complete account of what the line runs: a command or process substitution,
 * an arithmetic context that could evaluate code held in a variable, a
 * syntax error, an unterminated quote, a construct this module does not model
 * (`coproc`, `for ((…))`, a compound array assignment, a function
 * definition), a command that changes how later text is parsed (`shopt`,
 * `enable`, `set -o posix`, …), or a nesting depth past the limit. Nothing is
 * guessed. When the lexer is unsure it says so, and the caller refuses to
 * grant on that line.
 *
 * It is a lexer, not an interpreter. It does not know what `env`, `xargs` or
 * `sudo` do with their arguments, and it does not know what `eval` or `source`
 * will run; callers treat those as they see fit.
 */

/** One word of a command, before expansion and after quote removal. */
export interface ShellWord {
	/** The word as written in the source, quotes and escapes included. */
	readonly text: string
	/**
	 * The word after quote removal, with `$'…'` escapes decoded. Expansions
	 * that happen at runtime are left as written (`$HOME` stays `$HOME`), and
	 * {@link expands} says so.
	 */
	readonly value: string
	/**
	 * True when {@link value} is not the runtime word: the word contains an
	 * expansion, a glob, a brace expansion, a tilde prefix, or a
	 * locale-dependent quote or escape.
	 */
	readonly expands: boolean
	/** True when any part of the word was quoted or escaped. */
	readonly quoted: boolean
}

/** A redirection: `2>&1`, `> file`, `<<EOF` and the rest. */
export interface ShellRedirection {
	/**
	 * The operator: `<`, `>`, `>>`, `>|`, `<>`, `&>`, `&>>`, `<&`, `>&`, `<<`,
	 * `<<-` or `<<<`.
	 */
	readonly operator: string
	/** The descriptor it names before the operator (`2`, `{fd}`), if any. */
	readonly fd?: string
	/** The target word. For a here-document, its delimiter. */
	readonly target: ShellWord
	/**
	 * A here-document's body as written, up to its delimiter line, once the
	 * lexer has read it: the text the command reads on its input, which is
	 * a command line of its own when the command is a shell (`bash <<EOF`).
	 * Absent for every other operator and for a body the line never reached.
	 */
	readonly body?: string
}

/** One simple command. */
export interface ShellCommand {
	/**
	 * Every word, leading assignments included. `words[assignments]` is the
	 * command name when there is one.
	 */
	readonly words: readonly ShellWord[]
	/** How many leading words are variable assignments (`A=1 cmd`). */
	readonly assignments: number
	readonly redirections: readonly ShellRedirection[]
	/**
	 * The command's source text, from its first token to its last, taken from
	 * the string it was read from (the payload, for a nested shell).
	 */
	readonly text: string
	/**
	 * Where it was found: the line itself, a command or process substitution
	 * (which also makes the line opaque), or the payload of a nested
	 * `bash -c`.
	 */
	readonly origin: 'line' | 'substitution' | 'shell'
	/** How many `bash -c` payloads enclose it. */
	readonly depth: number
}

export interface ShellLexResult {
	/** Every simple command found, in the order its parse completed. */
	readonly commands: readonly ShellCommand[]
	/**
	 * Every redirection in the line, including those on compound commands
	 * (`{ a; } > f`) that belong to no single simple command.
	 */
	readonly redirections: readonly ShellRedirection[]
	/**
	 * Words that belong to no simple command: a `for` or `select` loop's
	 * variable and the words of its list, and a `case` statement's subject
	 * and patterns. `for d in ~/x; do rm -r "$d"; done` passes `~/x` to `rm`
	 * although no command lists it.
	 */
	readonly compoundWords: readonly ShellWord[]
	/** True when {@link commands} may not be everything the line runs. */
	readonly opaque: boolean
	/** False when parsing stopped early: a syntax error or an unsupported construct. */
	readonly complete: boolean
	/** Why the line is opaque, for diagnostics. Empty when it is not. */
	readonly reasons: readonly string[]
}

/**
 * Shells whose `-c` argument is another command line, by basename. The
 * payload is decoded as bash reads it; for `dash` and friends the bash reading
 * is a close approximation, and the line is only as exact as that.
 */
export const NESTED_SHELLS: ReadonlySet<string> = new Set([
	'sh',
	'bash',
	'zsh',
	'dash',
	'ksh',
	'ash',
	'mksh',
])

/** What {@link nestedShellCommand} found: the payload the lexer reads, or why it could not. */
export type NestedShellCommand =
	| {
			/** The shell's basename, one of {@link NESTED_SHELLS}. */
			readonly shell: string
			/** The `-c` argument, read as a command line of its own. */
			readonly payload: ShellWord
	  }
	| {
			/** Why the lexer calls the line opaque instead (`nested shell option` …). */
			readonly opaque: string
	  }

/**
 * Whether the lexer reads a simple command's payload as a command line of
 * its own: `words` are the command's words without its leading assignments.
 * The command must start a shell in {@link NESTED_SHELLS} by basename,
 * exactly as written (`bash`, `/bin/sh`; not `bash.exe`, `BASH` or `fish`),
 * or `busybox` running one, with `-c` among its options; the payload is the
 * first argument that is not an option. `null` when it reads no payload.
 *
 * A host deciding on {@link lexShellCommandLine}'s reading uses this to know
 * which text that reading already includes. Every other text a program runs
 * as code — `powershell -c '…'`, `fish -c '…'`, `bash.exe -c '…'`, a script
 * — is not in it.
 */
export function nestedShellCommand(words: readonly ShellWord[]): NestedShellCommand | null {
	const head = words[0]
	if (head === undefined || head.expands) return null
	const name = basename(head.value)
	if (name === 'busybox') {
		const next = words[1]
		return next !== undefined && !next.expands && NESTED_SHELLS.has(basename(next.value))
			? nestedShellCommand(words.slice(1))
			: null
	}
	if (!NESTED_SHELLS.has(name)) return null
	let command = false
	let payload: ShellWord | undefined
	for (let i = 1; i < words.length; i += 1) {
		const word = words[i] as ShellWord
		if (word.expands) return { opaque: 'nested shell option' }
		const value = word.value
		if (value === '--' || value === '-') {
			payload = words[i + 1]
			break
		}
		if (value.startsWith('--')) {
			if (value === '--rcfile' || value === '--init-file') i += 1
			continue
		}
		if (/^[-+][A-Za-z]+$/.test(value)) {
			if (value.startsWith('-') && value.includes('c')) command = true
			// `-o name`, `-O name`: the option takes the next word.
			if (/[oO]$/.test(value)) i += 1
			continue
		}
		payload = word
		break
	}
	if (!command) return null
	if (payload === undefined) return { opaque: 'nested shell without a command' }
	if (payload.expands) return { opaque: 'nested shell command is expanded at runtime' }
	return { shell: name, payload }
}

/** How many `bash -c` payloads deep the lexer follows before it gives up. */
const MAX_SHELL_DEPTH = 4
/** How deep compound commands and expansions may nest before it gives up. */
const MAX_NESTING = 100

import type { ShellDialect } from '../types/tool/index.js'

export type { ShellDialect }

export interface ShellLexOptions {
	/** Default `bash`. */
	readonly dialect?: ShellDialect
}

export function lexShellCommandLine(line: string, options: ShellLexOptions = {}): ShellLexResult {
	const context = new Context(line.length)
	context.setDialect(line, options.dialect ?? 'bash')
	try {
		lexInto(line, context, 'line', 0)
	} catch {
		// A defect here, or a stack exhausted by nesting, must not read as a
		// complete account of the line.
		context.complete = false
		context.opaque('internal error')
	}
	return {
		commands: context.commands,
		redirections: context.redirections,
		compoundWords: context.compoundWords,
		opaque: context.reasons.size > 0,
		complete: context.complete,
		reasons: [...context.reasons],
	}
}

class Context {
	readonly commands: ShellCommand[] = []
	readonly redirections: ShellRedirection[] = []
	readonly compoundWords: ShellWord[] = []
	readonly reasons = new Set<string>()
	complete = true
	/**
	 * Characters the lexer may re-read. A `((` is read once as arithmetic and,
	 * when that fails, again as two subshells; unbounded, nested attempts make
	 * the lexer quadratic. Past the budget the line is opaque.
	 */
	private rescans: number

	constructor(length: number) {
		this.rescans = 4 * length + 4096
	}

	opaque(reason: string): void {
		this.reasons.add(reason)
	}

	private readonly dialects = new Map<string, ShellDialect>()

	/** The dialect a string is read in. A string read two ways gets the stricter. */
	setDialect(src: string, dialect: ShellDialect): void {
		if (this.dialects.get(src) !== 'sh') this.dialects.set(src, dialect)
	}

	dialectFor(src: string): ShellDialect {
		return this.dialects.get(src) ?? 'sh'
	}

	private readonly sources = new Map<string, SourceState>()

	/** Per-string state shared by every parser reading that string. */
	source(src: string): SourceState {
		let state = this.sources.get(src)
		if (state === undefined) {
			state = { lastNewline: src.lastIndexOf('\n'), finalLineRaw: false }
			this.sources.set(src, state)
		}
		return state
	}

	/** Charge `count` re-read characters; stops the parse when spent. */
	rescan(count: number): void {
		this.rescans -= count
		if (this.rescans < 0) throw new Stop('too complex to read')
	}
}

/**
 * Bash appends a newline to each line it reads from a string. For a final line
 * that ends in a backslash it appends a second backslash instead, so the
 * backslash stays literal, but only when that line was read outside a single
 * quote. When the last newline of the string is inside `'…'` or `$'…'`, the
 * final line was read inside the quote, and a trailing backslash becomes a
 * line continuation that disappears (measured, bash 5.3).
 */
interface SourceState {
	readonly lastNewline: number
	finalLineRaw: boolean
}

/** Stops the parse. Whatever was read so far stays; the line becomes opaque. */
class Stop extends Error {
	constructor(readonly reason: string) {
		super(reason)
	}
}

function lexInto(
	source: string,
	context: Context,
	origin: ShellCommand['origin'],
	depth: number,
): void {
	const parser = new Parser(source, 0, context, origin, depth, 0)
	try {
		parser.program()
	} catch (error) {
		if (!(error instanceof Stop)) throw error
		context.complete = false
		context.opaque(error.reason)
	}
}

// ---------------------------------------------------------------------------
// Tokens

type Token =
	| {
			readonly kind: 'word'
			readonly start: number
			readonly end: number
			readonly word: ShellWord
			readonly reservedOk: boolean
	  }
	| {
			readonly kind: 'op'
			readonly start: number
			readonly end: number
			readonly op: string
			readonly fd?: string
	  }
	| { readonly kind: 'newline'; readonly start: number; readonly end: number }
	| { readonly kind: 'eof'; readonly start: number; readonly end: number }
	/** `(( … ))` at command position. */
	| { readonly kind: 'arith'; readonly start: number; readonly end: number }

const REDIRECTIONS = new Set([
	'<',
	'>',
	'>>',
	'>|',
	'<>',
	'&>',
	'&>>',
	'<&',
	'>&',
	'<<',
	'<<-',
	'<<<',
])

/** Operators after which bash recognises a reserved word. */
const RESERVED_AFTER_OPS = new Set([';', ';;', ';&', ';;&', '&', '&&', '||', '|', '|&', '(', ')'])
/** Reserved words after which bash recognises another one. */
const RESERVED_AFTER_WORDS = new Set([
	'!',
	'{',
	'}',
	'do',
	'done',
	'elif',
	'else',
	'esac',
	'fi',
	'if',
	'then',
	'time',
	'until',
	'while',
])
const RESERVED = new Set([
	'!',
	'{',
	'}',
	'case',
	'coproc',
	'do',
	'done',
	'elif',
	'else',
	'esac',
	'fi',
	'for',
	'function',
	'if',
	'select',
	'then',
	'time',
	'until',
	'while',
	'[[',
	']]',
	'in',
])

/** A compound command starts here (for `coproc NAME compound`). */
const COMPOUND_AFTER = /^(?:\(|(?:\{|if|while|until|for|select|case|\[\[)(?=[\s;&|()<>]|$))/
/** Builtins whose arguments may be array assignments. */
const ASSIGNMENT_BUILTINS = new Set(['declare', 'typeset', 'local', 'export', 'readonly'])

const WORD_BREAK = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>'])

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/

interface PendingHeredoc {
	readonly delimiter: string
	readonly stripTabs: boolean
	readonly quoted: boolean
	/** The redirection the body belongs to, filled in when it is read. */
	readonly redirection: { body?: string }
}

type Last =
	| { readonly kind: 'start' | 'newline' | 'other' }
	| { readonly kind: 'op'; readonly op: string }
	| { readonly kind: 'word'; readonly reserved: string | null }

/** A mutable word under construction. */
class WordBuilder {
	value = ''
	expands = false
	quoted = false
	/** A brace expansion, which POSIX shells do not perform. */
	brace = false
	/** Unquoted `{` seen, and whether a `,` or `..` followed it: brace expansion. */
	private braceOpen = false
	private braceSeparator = false
	/** The previous unquoted character, for tilde and brace detection. */
	private previous = ''
	private empty = true

	literal(char: string): void {
		this.value += char
		this.empty = false
	}

	/** An unquoted character, which may be special to expansion. */
	unquoted(char: string): void {
		if (char === '*' || char === '?' || char === '[') this.expands = true
		if (char === '~' && (this.empty || this.previous === '=' || this.previous === ':')) {
			this.expands = true
		}
		if (char === '{') {
			this.braceOpen = true
		} else if (this.braceOpen && (char === ',' || (char === '.' && this.previous === '.'))) {
			this.braceSeparator = true
		} else if (char === '}' && this.braceOpen && this.braceSeparator) {
			this.expands = true
			this.brace = true
		}
		this.previous = char
		this.literal(char)
	}

	/** Quoted text: never special. */
	quotedText(text: string): void {
		this.quoted = true
		this.previous = ''
		this.value += text
		this.empty = false
	}

	/** An expansion kept as written. */
	expansion(text: string): void {
		this.expands = true
		this.previous = ''
		this.value += text
		this.empty = false
	}
}

// ---------------------------------------------------------------------------
// The parser. One instance per string and per nesting of `$(…)`; the token
// stream is lazy so that a substitution can hand its position back.

class Parser {
	private peeked: Token | null = null
	private last: Last = { kind: 'start' }
	private readonly heredocs: PendingHeredoc[] = []
	private readonly source: SourceState

	constructor(
		private readonly src: string,
		public pos: number,
		private readonly context: Context,
		private readonly origin: ShellCommand['origin'],
		private readonly depth: number,
		private readonly nesting: number,
	) {
		if (nesting > MAX_NESTING) throw new Stop('nesting too deep')
		this.source = context.source(src)
	}

	private get dialect(): ShellDialect {
		return this.context.dialectFor(this.src)
	}

	/**
	 * A construct bash reads differently from a POSIX shell. In the `sh`
	 * dialect the line is opaque: which of the two runs it is not known.
	 */
	private bashOnly(what: string): void {
		if (this.dialect === 'sh') this.context.opaque(`not POSIX sh: ${what}`)
	}

	/** A string read inside this one (a backtick or here-document body) keeps its dialect. */
	private inherit(body: string): void {
		this.context.setDialect(body, this.dialect)
	}

	/** Record a single-quoted region; see {@link SourceState}. */
	private singleQuoted(open: number, close: number): void {
		const last = this.source.lastNewline
		if (last > open && last < close) this.source.finalLineRaw = true
	}

	// --- grammar ----------------------------------------------------------

	/** The whole string: a list, possibly empty, up to the end. */
	program(): void {
		this.newlines()
		while (this.peek().kind !== 'eof') {
			this.andOr()
			const token = this.peek()
			if (token.kind === 'eof') break
			if (
				token.kind === 'newline' ||
				(token.kind === 'op' && (token.op === ';' || token.op === '&'))
			) {
				this.take()
				this.newlines()
				continue
			}
			throw this.unexpected(token)
		}
	}

	/**
	 * A `$(…)` body: a list up to the matching `)`. Returns the offset just
	 * past it.
	 */
	substitution(): number {
		this.newlines()
		const first = this.peek()
		if (!(first.kind === 'op' && first.op === ')')) {
			this.list((token) => token.kind === 'op' && token.op === ')')
		}
		const close = this.take()
		if (close.kind !== 'op' || close.op !== ')') throw this.unexpected(close)
		return close.end
	}

	/**
	 * A `${ …; }` body: a list, possibly empty, up to a `}` where a command
	 * could start. That `}` closes the substitution even with more of the
	 * word after it: `a${ }b` is the word `ab`.
	 */
	braceSubstitution(): number {
		this.closesOnBrace = true
		const closing = (token: Token): boolean => token.kind === 'op' && token.op === '}'
		this.newlines()
		if (!closing(this.peek())) this.list(closing)
		return this.take().end
	}

	/** Set while reading a `${ …; }` body. */
	private closesOnBrace = false
	/** Open `{ …; }` groups, whose `}` is theirs and not the substitution's. */
	private braceDepth = 0

	/** After `{`: the list and its closing `}`. */
	private braceGroup(): void {
		this.braceDepth += 1
		try {
			this.list((t) => this.isReserved(t, '}'))
		} finally {
			this.braceDepth -= 1
		}
		this.take()
	}

	/**
	 * A compound list: one or more and-or lists separated by `;`, `&` or
	 * newlines, stopping before a token `ends` accepts.
	 */
	private list(ends: (token: Token) => boolean): void {
		this.newlines()
		if (ends(this.peek())) throw this.unexpected(this.peek())
		for (;;) {
			this.andOr()
			const token = this.peek()
			if (ends(token)) return
			if (
				token.kind === 'newline' ||
				(token.kind === 'op' && (token.op === ';' || token.op === '&'))
			) {
				this.take()
				this.newlines()
				if (ends(this.peek())) return
				continue
			}
			throw this.unexpected(token)
		}
	}

	private andOr(): void {
		this.pipeline()
		for (;;) {
			const token = this.peek()
			if (token.kind === 'op' && (token.op === '&&' || token.op === '||')) {
				this.take()
				this.newlines()
				this.pipeline()
				continue
			}
			return
		}
	}

	private pipeline(): void {
		// `time`, `time -p` and any number of `!` may lead a pipeline, and a
		// pipeline of just `time` or `!` is valid.
		let prefixed = false
		for (;;) {
			const token = this.peek()
			if (this.isReserved(token, '!')) {
				this.take()
				prefixed = true
				continue
			}
			if (this.isReserved(token, 'time')) {
				this.bashOnly('time')
				this.take()
				prefixed = true
				const option = this.peek()
				if (option.kind === 'word' && option.word.text.startsWith('-')) {
					// In POSIX mode, which is how bash runs as `/bin/sh`, `time`
					// before a word starting with `-` is not a reserved word but
					// the command `time`. The two modes disagree about what runs.
					this.context.opaque('time with an option')
				}
				if (
					option.kind === 'word' &&
					!option.word.quoted &&
					(option.word.value === '-p' || option.word.value === '--')
				) {
					this.take()
					this.last = { kind: 'word', reserved: 'time' }
				}
				continue
			}
			break
		}
		// `!` or `time` with nothing after it is valid only before a newline,
		// a `;` or the end of the input. (Bash 5.3 also accepts a `&`; 5.2
		// does not, and reading it as an error is the direction that fails
		// closed.)
		if (prefixed) {
			const next = this.peek()
			if (next.kind === 'eof' || next.kind === 'newline' || (next.kind === 'op' && next.op === ';'))
				return
		}
		this.command()
		for (;;) {
			const token = this.peek()
			if (token.kind === 'op' && (token.op === '|' || token.op === '|&')) {
				this.take()
				this.newlines()
				this.afterPipe = true
				this.command()
				continue
			}
			return
		}
	}

	private command(): void {
		this.level += 1
		try {
			if (this.nestingNow > MAX_NESTING) throw new Stop('nesting too deep')
			this.commandAt()
		} finally {
			this.level -= 1
		}
	}

	/** Set between a `|` and the command after it, where `time` is a plain word. */
	private afterPipe = false

	private commandAt(): void {
		const afterPipe = this.afterPipe
		this.afterPipe = false
		const token = this.peek()
		if (token.kind === 'arith') {
			this.take()
			this.redirectionsAfterCompound()
			return
		}
		if (token.kind === 'op' && token.op === '(') {
			this.take()
			this.list((t) => t.kind === 'op' && t.op === ')')
			this.expectOp(')')
			this.redirectionsAfterCompound()
			return
		}
		if (
			token.kind === 'word' &&
			token.reservedOk &&
			token.word.text.replace(/\\\n/g, '') === '[['
		) {
			this.bashOnly('[[')
			this.conditional()
			this.redirectionsAfterCompound()
			return
		}
		if (
			token.kind === 'word' &&
			token.reservedOk &&
			!token.word.quoted &&
			!token.word.expands &&
			!(afterPipe && token.word.value === 'time')
		) {
			switch (token.word.value) {
				case '{':
					this.take()
					this.braceGroup()
					this.redirectionsAfterCompound()
					return
				case 'if':
					this.ifCommand()
					this.redirectionsAfterCompound()
					return
				case 'while':
				case 'until':
					this.take()
					this.list((t) => this.isReserved(t, 'do'))
					this.take()
					this.list((t) => this.isReserved(t, 'done'))
					this.take()
					this.redirectionsAfterCompound()
					return
				case 'for':
				case 'select':
					if (token.word.value === 'select') this.bashOnly('select')
					this.forCommand()
					this.redirectionsAfterCompound()
					return
				case 'case':
					this.caseCommand()
					this.redirectionsAfterCompound()
					return
				case 'function':
					this.bashOnly('function')
					this.context.opaque('function definition')
					this.take()
					this.functionBody(true)
					return
				case 'coproc': {
					this.bashOnly('coproc')
					// `coproc [NAME] command`: runs in the background, and its
					// descriptors land in a variable. Read the command; opaque.
					this.context.opaque('coproc')
					this.take()
					const next = this.peek()
					if (
						next.kind === 'word' &&
						COMPOUND_AFTER.test(this.src.slice(this.skipBlanks(next.end)))
					) {
						this.take()
						const body = this.peek()
						if (body.kind === 'word') this.peeked = { ...body, reservedOk: true }
					}
					this.command()
					return
				}
				case '}':
				case 'then':
				case 'else':
				case 'elif':
				case 'fi':
				case 'do':
				case 'done':
				case 'esac':
				case '!':
				case 'time':
				case 'in':
				case ']]':
					throw this.unexpected(token)
			}
		}
		this.simpleCommand()
	}

	private ifCommand(): void {
		this.take()
		this.list((t) => this.isReserved(t, 'then'))
		this.take()
		this.list(
			(t) => this.isReserved(t, 'elif') || this.isReserved(t, 'else') || this.isReserved(t, 'fi'),
		)
		for (;;) {
			const token = this.take()
			if (this.isReserved(token, 'fi')) return
			if (this.isReserved(token, 'elif')) {
				this.list((t) => this.isReserved(t, 'then'))
				this.take()
				this.list(
					(t) =>
						this.isReserved(t, 'elif') || this.isReserved(t, 'else') || this.isReserved(t, 'fi'),
				)
				continue
			}
			// else
			this.list((t) => this.isReserved(t, 'fi'))
			this.take()
			return
		}
	}

	private forCommand(): void {
		this.take()
		const header = this.skipBlanks(this.pos)
		let token: Token
		if (this.peeked === null && this.src.startsWith('((', header)) {
			// `for (( init; test; step ))`: arithmetic throughout.
			const end = this.scanArithmetic(header + 2)
			if (end < 0) throw new Stop('syntax error: arithmetic for loop')
			this.bashOnly('for ((…))')
			this.arithmeticContent(this.src.slice(header + 2, end - 2), header + 2)
			this.pos = end
			this.last = { kind: 'other' }
			this.newlines()
			token = this.peek()
			if (token.kind === 'op' && token.op === ';') {
				this.take()
				this.newlines()
			}
			this.loopBody()
			return
		}
		const name = this.takePlainWord()
		if (name.kind !== 'word') throw this.unexpected(name)
		this.context.compoundWords.push(name.word)
		this.newlines()
		token = this.peek()
		if (token.kind === 'word' && !token.word.quoted && token.word.value === 'in') {
			this.take()
			// Inside a case statement, bash reads `esac` right after `in` as
			// the end of the case.
			const first = this.peekPlainWord()
			if (
				this.caseDepth > 0 &&
				first.kind === 'word' &&
				!first.word.quoted &&
				first.word.value === 'esac'
			) {
				throw this.unexpected(first)
			}
			for (;;) {
				token = this.takePlainWord()
				if (token.kind === 'word') {
					this.context.compoundWords.push(token.word)
					continue
				}
				if (token.kind === 'newline' || (token.kind === 'op' && token.op === ';')) break
				throw this.unexpected(token)
			}
			this.newlines()
		} else if (token.kind === 'op' && token.op === ';') {
			this.take()
			this.newlines()
		}
		this.loopBody()
	}

	/** `do list done`, or bash's `{ list }` in its place. */
	private loopBody(): void {
		const token = this.peek()
		if (this.isReservedAnywhere(token, 'do')) {
			this.take()
			this.list((t) => this.isReserved(t, 'done'))
			this.take()
			return
		}
		if (this.isReservedAnywhere(token, '{')) {
			this.bashOnly('a { } loop body')
			this.take()
			this.braceGroup()
			return
		}
		throw this.unexpected(token)
	}

	private caseDepth = 0

	private caseCommand(): void {
		this.caseDepth += 1
		try {
			this.caseBody()
		} finally {
			this.caseDepth -= 1
			this.assignmentSyntax = true
			this.allowCompound = true
		}
	}

	private caseBody(): void {
		this.take()
		const subject = this.takePlainWord()
		if (subject.kind !== 'word') throw this.unexpected(subject)
		this.context.compoundWords.push(subject.word)
		this.newlines()
		const keyword = this.take()
		if (keyword.kind !== 'word' || keyword.word.quoted || keyword.word.value !== 'in') {
			throw this.unexpected(keyword)
		}
		// Patterns are never assignments.
		const patterns = (): void => {
			this.assignmentSyntax = false
			this.allowCompound = false
		}
		patterns()
		this.newlines()
		for (;;) {
			patterns()
			let token = this.peek()
			if (
				token.kind === 'word' &&
				!token.word.quoted &&
				!token.word.expands &&
				token.word.value === 'esac'
			) {
				this.take()
				return
			}
			if (token.kind === 'op' && token.op === '(') {
				this.take()
				token = this.peek()
			}
			// One or more patterns separated by `|`, then `)`.
			for (;;) {
				patterns()
				const pattern = this.take()
				if (pattern.kind !== 'word') throw this.unexpected(pattern)
				this.context.compoundWords.push(pattern.word)
				const next = this.take()
				if (next.kind === 'op' && next.op === '|') continue
				if (next.kind === 'op' && next.op === ')') break
				throw this.unexpected(next)
			}
			this.assignmentSyntax = true
			this.allowCompound = true
			this.newlines()
			token = this.peek()
			const endsClause = (t: Token): boolean =>
				(t.kind === 'op' && (t.op === ';;' || t.op === ';&' || t.op === ';;&')) ||
				(t.kind === 'word' && !t.word.quoted && !t.word.expands && t.word.value === 'esac')
			if (!endsClause(token)) this.list(endsClause)
			token = this.take()
			if (token.kind === 'word') return // esac
			patterns()
			this.newlines()
		}
	}

	/**
	 * `[[ … ]]`. Nothing in it runs a command except a substitution, which
	 * word reading already records. Its operands are arithmetic in places
	 * (`-eq`), which can evaluate code held in a variable, so it is opaque.
	 */
	private conditional(): void {
		this.take()
		this.context.opaque('conditional expression')
		this.assignmentSyntax = false
		this.allowCompound = false
		for (;;) {
			const token = this.takeConditional()
			if (token.kind === 'eof') throw new Stop('unterminated [[')
			if (token.kind === 'word' && !token.word.quoted && token.word.value === ']]') {
				// Like `((…))`, a finished `[[…]]` accepts a reserved word next.
				this.last = { kind: 'word', reserved: '}' }
				this.assignmentSyntax = true
				this.allowCompound = true
				return
			}
		}
	}

	/** `name () body` or `function name [()] body`. */
	private functionBody(keyword: boolean): void {
		if (keyword) {
			const name = this.take()
			if (name.kind !== 'word') throw this.unexpected(name)
		}
		const open = this.peek()
		if (open.kind === 'op' && open.op === '(') {
			this.take()
			this.expectOp(')')
		} else if (!keyword) {
			throw this.unexpected(open)
		}
		this.newlines()
		// The body must be a compound command; the reserved word is recognised
		// here whatever came before it.
		const body = this.peek()
		if (
			body.kind === 'word' &&
			!body.word.quoted &&
			['{', 'if', 'while', 'until', 'for', 'select', 'case', '[['].includes(body.word.value)
		) {
			this.peeked = { ...body, reservedOk: true }
			this.command()
			return
		}
		if (body.kind === 'op' && body.op === '(') {
			this.command()
			return
		}
		if (body.kind === 'arith') {
			this.command()
			return
		}
		throw this.unexpected(body)
	}

	private redirectionsAfterCompound(): void {
		for (;;) {
			const token = this.peek()
			if (token.kind === 'op' && REDIRECTIONS.has(token.op)) {
				this.take()
				this.context.redirections.push(this.redirectionTarget(token))
				continue
			}
			if (token.kind === 'word') throw this.unexpected(token)
			return
		}
	}

	private simpleCommand(): void {
		const words: ShellWord[] = []
		const redirections: ShellRedirection[] = []
		let assignments = 0
		let afterAssignment = false
		let start = -1
		let end = -1
		for (;;) {
			// `NAME=(…)` and `NAME[…]` are read as assignment syntax only where an
			// assignment can stand: first in the command (after any leading
			// redirections), or right after another assignment. An array also
			// counts as an argument of `declare` and its kin.
			this.assignmentSyntax =
				words.length === 0 || (words.length === assignments && afterAssignment)
			this.allowCompound =
				this.assignmentSyntax || ASSIGNMENT_BUILTINS.has(words[assignments]?.value ?? '')
			const token = this.peek()
			if (token.kind === 'word') {
				this.take()
				if (start < 0) start = token.start
				end = token.end
				afterAssignment = false
				if (words.length === assignments && ASSIGNMENT.test(joined(token.word.text))) {
					assignments += 1
					if (/^[A-Za-z_][A-Za-z0-9_]*(?:\[|\+=)/.test(joined(token.word.text)))
						this.bashOnly('array or += assignment')
					afterAssignment = true
					const subscript = /^[A-Za-z_][A-Za-z0-9_]*\[([^\]]*)\]/.exec(joined(token.word.text))
					if (subscript && !/^\d*$/.test(subscript[1] as string))
						this.context.opaque('arithmetic subscript')
				}
				words.push(token.word)
				continue
			}
			if (token.kind === 'op' && REDIRECTIONS.has(token.op)) {
				this.take()
				if (start < 0) start = token.start
				afterAssignment = false
				// A bash 5 quirk, measured: in a command that so far has only
				// redirections, the target of a later `&>>` is read as an
				// assignment word, subscript included, and rejected when it is
				// shaped like one.
				const quirk = token.op === '&>>' && words.length === 0 && redirections.length > 0
				const redirection = this.redirectionTarget(token, quirk)
				if (quirk && ASSIGNMENT.test(joined(redirection.target.text)))
					throw new Stop('syntax error')
				end = this.lastEnd
				redirections.push(redirection)
				this.context.redirections.push(redirection)
				continue
			}
			if (
				token.kind === 'op' &&
				token.op === '(' &&
				words.length === 1 &&
				assignments === 0 &&
				redirections.length === 0
			) {
				// `name ( ) compound`: a function definition. Its body runs only
				// when something calls it, under a name no rule sees.
				this.context.opaque('function definition')
				this.functionBody(false)
				return
			}
			break
		}
		this.allowCompound = true
		this.assignmentSyntax = true
		if (start < 0) throw this.unexpected(this.peek())
		const command: ShellCommand = {
			words,
			assignments,
			redirections,
			text: this.src.slice(start, end),
			origin: this.origin,
			depth: this.depth,
		}
		this.context.commands.push(command)
		this.inspect(command)
	}

	/**
	 * Take the next token where no assignment syntax applies: a redirection
	 * target, a `for` name or word, a `case` subject.
	 */
	private takePlainWord(): Token {
		const assignmentSyntax = this.assignmentSyntax
		const allowCompound = this.allowCompound
		this.assignmentSyntax = false
		this.allowCompound = false
		try {
			return this.take()
		} finally {
			this.assignmentSyntax = assignmentSyntax
			this.allowCompound = allowCompound
		}
	}

	private peekPlainWord(): Token {
		const assignmentSyntax = this.assignmentSyntax
		const allowCompound = this.allowCompound
		this.assignmentSyntax = false
		this.allowCompound = false
		try {
			return this.peek()
		} finally {
			this.assignmentSyntax = assignmentSyntax
			this.allowCompound = allowCompound
		}
	}

	/** The end offset of the last token taken. */
	private lastEnd = 0
	/** Whether a word may be a compound array assignment here. */
	private allowCompound = true
	/** Whether `NAME[…]` is read as a subscript here, spaces and all. */
	private assignmentSyntax = true

	private redirectionTarget(
		operator: Token & { kind: 'op' },
		assignmentSyntax = false,
	): ShellRedirection {
		const target = assignmentSyntax ? this.take() : this.takePlainWord()
		if (target.kind !== 'word') throw this.unexpected(target)
		if (
			(operator.op === '>&' || operator.op === '<&') &&
			(target.word.quoted || target.word.expands)
		) {
			// Bash 5.2 expands the target of `>&` twice: `x >&2'$(cmd)'` and
			// `x >&2${v:-'$(cmd)'}` run `cmd`, which the parse saw quoted
			// (measured; fixed in 5.3, and 5.2 is what current Debian and
			// Ubuntu ship).
			this.context.opaque('quoted or expanding target of >& or <&')
		}
		const redirection: { -readonly [K in keyof ShellRedirection]: ShellRedirection[K] } = {
			operator: operator.op,
			...(operator.fd !== undefined ? { fd: operator.fd } : {}),
			target: target.word,
		}
		if (operator.op === '<<' || operator.op === '<<-') {
			if (target.word.value.includes('\n')) {
				// Bash starts the body at the newline inside the delimiter, so
				// the rest of the line is body text. Reading on as commands
				// reports more than runs, which is the safe way to be wrong.
				this.context.opaque('here-document delimiter spans lines')
			} else
				this.heredocs.push({
					delimiter: target.word.value,
					stripTabs: operator.op === '<<-',
					quoted: target.word.quoted,
					redirection,
				})
		}
		return redirection
	}

	/**
	 * What a finished simple command means for the rest of the line: a nested
	 * shell to read, or a command that changes how bash parses what follows.
	 */
	private inspect(command: ShellCommand): void {
		for (const word of command.words) {
			// Either variable, set in the line, changes how bash parses the rest.
			if (word.value.includes('POSIXLY_CORRECT=') || word.value.includes('BASH_COMPAT=')) {
				this.context.opaque('parser setting')
			}
		}
		const head = command.words[command.assignments]
		if (head === undefined || head.expands) return
		const name = basename(head.value)
		if (
			name !== 'shopt' &&
			name !== 'enable' &&
			name !== 'set' &&
			name !== 'busybox' &&
			!NESTED_SHELLS.has(name)
		)
			return
		const words = command.words.slice(command.assignments)
		if (name === 'shopt' || name === 'enable') {
			this.context.opaque('parser setting')
			return
		}
		if (name === 'set') {
			for (let i = 1; i < words.length; i += 1) {
				const word = words[i] as ShellWord
				if (word.expands) this.context.opaque('parser setting')
				if (/^[-+][A-Za-z]*k/.test(word.value) || word.value === '--posix')
					this.context.opaque('parser setting')
				if (
					/^[-+][A-Za-z]*o$/.test(word.value) &&
					/^(?:posix|keyword)$/.test(words[i + 1]?.value ?? '')
				) {
					this.context.opaque('parser setting')
				}
			}
			return
		}
		const nested = nestedShellCommand(words)
		if (nested === null) return
		if ('opaque' in nested) {
			this.context.opaque(nested.opaque)
			return
		}
		this.nestedShell(nested.shell, nested.payload)
	}

	/** Read the payload of `bash -c payload` as a command line of its own. */
	private nestedShell(shell: string, payload: ShellWord): void {
		if (this.depth + 1 >= MAX_SHELL_DEPTH) {
			this.context.opaque('nested shells too deep')
			return
		}
		const origin = this.origin === 'substitution' ? 'substitution' : 'shell'
		this.context.rescan(payload.value.length)
		// `bash -c` is read as bash. Another shell is read in the dialect
		// that holds for every POSIX shell; zsh and ksh go beyond POSIX in
		// ways this lexer does not model, so their payloads are opaque, and
		// still read for what a deny rule can see.
		this.context.setDialect(payload.value, shell === 'bash' ? 'bash' : 'sh')
		if (shell === 'zsh' || shell === 'ksh' || shell === 'mksh')
			this.context.opaque(`nested ${shell} is not modeled`)
		const inner = new Parser(
			payload.value,
			0,
			this.context,
			origin,
			this.depth + 1,
			this.nestingNow + 1,
		)
		try {
			inner.program()
		} catch (error) {
			if (!(error instanceof Stop)) throw error
			// The payload does not parse. Bash would refuse it, but this
			// reading may be wrong about that, so it is opaque rather than empty.
			this.context.opaque(`nested shell: ${error.reason}`)
		}
	}

	/** Compound commands nest on the JS stack; bound how deep. */
	private level = 0
	private get nestingNow(): number {
		return this.nesting + this.level
	}

	private expectOp(op: string): Token {
		const token = this.take()
		if (token.kind !== 'op' || token.op !== op) throw this.unexpected(token)
		return token
	}

	private newlines(): void {
		while (this.peek().kind === 'newline') this.take()
	}

	private isReserved(token: Token, name: string): boolean {
		return (
			token.kind === 'word' &&
			token.reservedOk &&
			!token.word.quoted &&
			!token.word.expands &&
			token.word.value === name
		)
	}

	/** A reserved word recognised by position in a `for` header regardless of what preceded it. */
	private isReservedAnywhere(token: Token, name: string): boolean {
		return (
			token.kind === 'word' &&
			!token.word.quoted &&
			!token.word.expands &&
			token.word.value === name
		)
	}

	private unexpected(token: Token): Stop {
		if (token.kind === 'eof') return new Stop('syntax error: unexpected end of input')
		return new Stop('syntax error')
	}

	// --- tokens -----------------------------------------------------------

	private peek(): Token {
		if (this.peeked === null) this.peeked = this.read()
		return this.peeked
	}

	private take(): Token {
		const token = this.peek()
		this.peeked = null
		this.lastEnd = token.end
		if (token.kind === 'word') {
			const reserved =
				token.reservedOk &&
				!token.word.quoted &&
				!token.word.expands &&
				RESERVED.has(token.word.value)
					? token.word.value
					: null
			this.last = { kind: 'word', reserved }
		} else if (token.kind === 'op') {
			this.last = { kind: 'op', op: token.op }
		} else if (token.kind === 'newline') {
			this.last = { kind: 'newline' }
		} else {
			this.last = { kind: 'other' }
		}
		return token
	}

	private reservedOk(): boolean {
		const last = this.last
		switch (last.kind) {
			case 'start':
			case 'newline':
				return true
			case 'op':
				return RESERVED_AFTER_OPS.has(last.op)
			case 'word':
				return last.reserved !== null && RESERVED_AFTER_WORDS.has(last.reserved)
			default:
				return false
		}
	}

	/** Skip any `\<newline>` pairs at `at`: bash removes them before tokenizing. */
	private cont(at: number): number {
		let i = at
		for (;;) {
			if (this.src[i] !== '\\') return i
			const next = i + 1
			if (this.src[next] === '\n') i += 2
			else if (next === this.src.length && this.source.finalLineRaw) {
				this.bashOnly('a trailing backslash')
				i += 1
			} else return i
		}
	}

	private skipBlanks(at: number): number {
		let i = this.cont(at)
		while (this.src[i] === ' ' || this.src[i] === '\t') i = this.cont(i + 1)
		return i
	}

	private read(): Token {
		const src = this.src
		for (;;) {
			const start = this.skipBlanks(this.pos)
			this.pos = start
			if (start >= src.length) return { kind: 'eof', start, end: start }
			const char = src[start] as string
			if (char === '#') {
				// A comment runs to the newline; continuations do not extend it.
				let i = start
				while (i < src.length && src[i] !== '\n') i += 1
				this.pos = i
				continue
			}
			if (char === '\n') {
				this.pos = start + 1
				this.readHeredocs()
				return { kind: 'newline', start, end: start + 1 }
			}
			if (char === '}' && this.closesOnBrace && this.braceDepth === 0 && this.reservedOk()) {
				this.pos = start + 1
				return { kind: 'op', start, end: start + 1, op: '}' }
			}
			// After `<&` or `>&`, bash takes a `-` as a token of its own: `3<&-a`
			// closes descriptor 3 and `a` is the next word.
			if (
				char === '-' &&
				this.last.kind === 'op' &&
				(this.last.op === '<&' || this.last.op === '>&')
			) {
				const after = src[this.cont(start + 1)]
				if (after !== undefined && !WORD_BREAK.has(after))
					this.bashOnly('a word glued to <&- or >&-')
				this.pos = start + 1
				return {
					kind: 'word',
					start,
					end: start + 1,
					word: { text: '-', value: '-', expands: false, quoted: false },
					reservedOk: false,
				}
			}
			return this.operatorOrWord(start)
		}
	}

	/** Read the operator starting at `start`, or a word. */
	private operatorOrWord(start: number): Token {
		const src = this.src
		const char = src[start] as string
		const n1 = this.cont(start + 1)
		const c1 = src[n1]
		const op = (text: string, end: number, fd?: string): Token => {
			this.pos = end
			return fd === undefined
				? { kind: 'op', start, end, op: text }
				: { kind: 'op', start, end, op: text, fd }
		}
		switch (char) {
			case ';': {
				if (c1 === ';') {
					const n2 = this.cont(n1 + 1)
					if (src[n2] === '&') {
						this.bashOnly(';;&')
						return op(';;&', n2 + 1)
					}
					return op(';;', n1 + 1)
				}
				if (c1 === '&') {
					this.bashOnly(';&')
					return op(';&', n1 + 1)
				}
				return op(';', start + 1)
			}
			case '&': {
				if (c1 === '&') return op('&&', n1 + 1)
				if (c1 === '>') {
					const n2 = this.cont(n1 + 1)
					this.bashOnly('&> and &>>')
					if (src[n2] === '>') return op('&>>', n2 + 1)
					return op('&>', n1 + 1)
				}
				return op('&', start + 1)
			}
			case '|': {
				if (c1 === '|') return op('||', n1 + 1)
				if (c1 === '&') {
					this.bashOnly('|&')
					return op('|&', n1 + 1)
				}
				return op('|', start + 1)
			}
			case '(': {
				if (c1 === '(' && this.reservedOk()) {
					const end = this.arithmeticCommand(n1 + 1)
					if (end >= 0) {
						this.pos = end
						this.bashOnly('((…))')
						return { kind: 'arith', start, end }
					}
				}
				return op('(', start + 1)
			}
			case ')':
				return op(')', start + 1)
			case '<':
			case '>': {
				if (c1 === '(') return this.word(start)
				return this.redirectionOperator(start, undefined)
			}
		}
		return this.word(start)
	}

	private redirectionOperator(start: number, fd: string | undefined): Token {
		const src = this.src
		const char = src[start] as string
		const n1 = this.cont(start + 1)
		const c1 = src[n1]
		const done = (text: string, end: number): Token => {
			this.pos = end
			return fd === undefined
				? { kind: 'op', start, end, op: text }
				: { kind: 'op', start, end, op: text, fd }
		}
		if (char === '<') {
			if (c1 === '<') {
				const n2 = this.cont(n1 + 1)
				if (src[n2] === '<') {
					this.bashOnly('<<<')
					return done('<<<', n2 + 1)
				}
				if (src[n2] === '-') return done('<<-', n2 + 1)
				return done('<<', n1 + 1)
			}
			if (c1 === '>') return done('<>', n1 + 1)
			if (c1 === '&') return done('<&', n1 + 1)
			return done('<', start + 1)
		}
		if (c1 === '>') return done('>>', n1 + 1)
		if (c1 === '|') return done('>|', n1 + 1)
		if (c1 === '&') return done('>&', n1 + 1)
		return done('>', start + 1)
	}

	/** Tokens inside `[[ … ]]`, where `<`, `>` and `(` are operands. */
	private takeConditional(): Token {
		this.peeked = null
		const start = this.skipBlanks(this.pos)
		this.pos = start
		const src = this.src
		if (start >= src.length) return { kind: 'eof', start, end: start }
		const char = src[start] as string
		if (char === '\n') {
			this.pos = start + 1
			this.readHeredocs()
			return { kind: 'newline', start, end: start + 1 }
		}
		if (char === '<' || char === '>' || char === '(' || char === ')' || char === ';') {
			this.pos = start + 1
			return { kind: 'op', start, end: start + 1, op: char }
		}
		if (char === '&' || char === '|') {
			const n1 = this.cont(start + 1)
			const end = src[n1] === char ? n1 + 1 : start + 1
			this.pos = end
			return { kind: 'op', start, end, op: src.slice(start, end) }
		}
		const token = this.word(start)
		return token
	}

	/**
	 * `(( … ))` at command position. Returns the offset past the closing
	 * `))`, or -1 when the parentheses do not close that way, in which case
	 * bash reads the text as nested subshells instead.
	 */
	private arithmeticCommand(from: number): number {
		const scanned = this.scanArithmetic(from)
		if (scanned < 0) return -1
		const content = this.src.slice(from, scanned - 2)
		this.arithmeticContent(content, from)
		return scanned
	}

	/**
	 * Scan arithmetic text from `from` to the `))` that closes it at depth
	 * zero. Returns the offset past `))`, or -1.
	 */
	private scanArithmetic(from: number): number {
		const src = this.src
		let depth = 0
		let i = from
		while (i < src.length) {
			i = this.cont(i)
			const char = src[i]
			if (char === undefined) return -1
			if (char === '\\') {
				i += 2
				continue
			}
			if (char === "'" || char === '"' || char === '`') {
				const close = src.indexOf(char, i + 1)
				if (close < 0) {
					this.context.rescan(src.length - from)
					return -1
				}
				i = close + 1
				continue
			}
			if (char === '(') depth += 1
			else if (char === ')') {
				if (depth === 0) {
					const next = this.cont(i + 1)
					this.context.rescan(i - from)
					return src[next] === ')' ? next + 1 : -1
				}
				depth -= 1
			}
			i += 1
		}
		this.context.rescan(i - from)
		return -1
	}

	/**
	 * Arithmetic evaluates variables recursively, and a variable holding
	 * `a[$(cmd)]` runs `cmd`. Only arithmetic on literals is transparent.
	 */
	private arithmeticContent(content: string, at: number): void {
		const plain = content.replace(/\\\n/g, '')
		if (/^[0-9\s+\-*/%()<>=!&|^~?:,]*$/.test(plain)) return
		this.context.opaque('arithmetic')
		if (/\$\(|`/.test(plain)) {
			// Read the substitution for the commands it runs.
			this.scanForSubstitutions(at, at + content.length)
		}
	}

	/** Record the commands inside any `$(…)` or backticks in [from, to). */
	private scanForSubstitutions(from: number, to: number): void {
		let i = from
		while (i < to) {
			const char = this.src[i]
			if (char === '$' && this.src[i + 1] === '(' && this.src[i + 2] !== '(') {
				const inner = new Parser(
					this.src,
					i + 2,
					this.context,
					'substitution',
					this.depth,
					this.nestingNow + 1,
				)
				try {
					i = inner.substitution()
				} catch (error) {
					if (!(error instanceof Stop)) throw error
					return
				}
				continue
			}
			if (char === '`') {
				const end = this.backtick(i, new WordBuilder(), false)
				i = end
				continue
			}
			i += 1
		}
	}

	// --- here-documents ---------------------------------------------------

	/** Consume the bodies of here-documents opened on the line just ended. */
	private readHeredocs(): void {
		const src = this.src
		while (this.heredocs.length > 0) {
			const heredoc = this.heredocs.shift() as PendingHeredoc
			let i = this.pos
			const bodyStart = i
			let bodyEnd = i
			for (;;) {
				bodyEnd = i
				if (i >= src.length) break
				let line = ''
				let j = i
				for (;;) {
					const newline = src.indexOf('\n', j)
					const lineEnd = newline < 0 ? src.length : newline
					const piece = src.slice(j, lineEnd)
					// In an unquoted body, a backslash that escapes the newline
					// joins the lines before the delimiter test.
					if (!heredoc.quoted && newline >= 0 && trailingBackslashes(piece) % 2 === 1) {
						this.bashOnly('a line continuation in a here-document')
						line += piece.slice(0, -1)
						j = newline + 1
						continue
					}
					line += piece
					j = newline < 0 ? src.length : newline + 1
					break
				}
				const test = heredoc.stripTabs ? line.replace(/^\t+/, '') : line
				i = j
				if (test === heredoc.delimiter) break
				bodyEnd = i
			}
			heredoc.redirection.body = src.slice(bodyStart, bodyEnd)
			if (!heredoc.quoted) {
				const body = src.slice(bodyStart, i)
				if (/\$[({[]|`/.test(body)) this.heredocBody(body)
			}
			this.pos = i
		}
	}

	/** An unquoted here-document body expands; read it for substitutions. */
	private heredocBody(body: string): void {
		// Parameter expansion in a body runs nothing; substitution and
		// arithmetic might. Read with double-quote rules, where `"` is plain.
		this.context.rescan(body.length)
		this.inherit(body)
		const reader = new Parser(body, 0, this.context, this.origin, this.depth, this.nestingNow + 1)
		try {
			let i = 0
			const builder = new WordBuilder()
			while (i < body.length) {
				const char = body[i]
				if (char === '\\') {
					i += 2
					continue
				}
				if (char === '$') {
					i = reader.dollar(i, builder, true)
					continue
				}
				if (char === '`') {
					i = reader.backtick(i, builder, true)
					continue
				}
				i += 1
			}
		} catch (error) {
			if (!(error instanceof Stop)) throw error
			this.context.opaque(`here-document: ${error.reason}`)
		}
	}

	// --- words ------------------------------------------------------------

	private word(start: number): Token {
		const reservedOk = this.reservedOk()
		const src = this.src
		const builder = new WordBuilder()
		let i = start
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) break
			const char = src[i] as string
			if (WORD_BREAK.has(char)) {
				// `<(…)` and `>(…)` are words of their own.
				// `<(…)` and `>(…)` are read as part of the word, even mid-word.
				if ((char === '<' || char === '>') && src[this.cont(i + 1)] === '(') {
					i = this.processSubstitution(i, builder)
					continue
				}
				if (
					char === '(' &&
					this.allowCompound &&
					/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$/.test(joined(src.slice(start, i)))
				) {
					this.bashOnly('array assignment')
					i = this.compoundArray(i + 1, builder)
					continue
				}
				break
			}
			if (
				char === '[' &&
				this.assignmentSyntax &&
				/^[A-Za-z_][A-Za-z0-9_]*$/.test(joined(src.slice(start, i)))
			) {
				// `NAME[…]` where an assignment may stand: bash reads the
				// subscript as one unit, blanks and quotes included.
				this.bashOnly('subscript')
				const close = this.subscript(i + 1)
				builder.expansion(src.slice(i, close))
				i = close
				continue
			}
			if (char === '\\') {
				if (i + 1 >= src.length) {
					// A trailing backslash is a literal backslash.
					this.bashOnly('a trailing backslash')
					builder.literal('\\')
					i += 1
					continue
				}
				builder.quotedText(src[i + 1] as string)
				i += 2
				continue
			}
			if (char === "'") {
				const close = src.indexOf("'", i + 1)
				if (close < 0) throw new Stop('unterminated quote')
				this.singleQuoted(i, close)
				builder.quotedText(src.slice(i + 1, close))
				i = close + 1
				continue
			}
			if (char === '"') {
				i = this.doubleQuoted(i + 1, builder)
				continue
			}
			if (char === '`') {
				i = this.backtick(i, builder, false)
				continue
			}
			if (char === '$') {
				i = this.dollar(i, builder, false)
				continue
			}
			builder.unquoted(char)
			i += 1
		}
		this.pos = i
		if (builder.brace) this.bashOnly('brace expansion')
		const word: ShellWord = {
			text: src.slice(start, i),
			value: builder.value,
			expands: builder.expands,
			quoted: builder.quoted,
		}
		// A descriptor before a redirection operator: `2>`, `{fd}>`.
		const next = src[i]
		if ((next === '<' || next === '>') && src[this.cont(i + 1)] !== '(') {
			const fd = joined(word.text)
			if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(fd)) this.bashOnly('{name} redirection')
			if (/^\d+$/.test(fd) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(fd)) {
				const operator = this.redirectionOperator(i, fd)
				return { ...operator, start }
			}
		}
		return { kind: 'word', start, end: i, word, reservedOk }
	}

	/**
	 * After the `(` of `NAME=(…)`: read the element words to the closing `)`.
	 * Returns the offset past it. The whole word is marked as expanding: an
	 * array is not one argument.
	 */
	private compoundArray(from: number, builder: WordBuilder): number {
		const src = this.src
		let i = from
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) throw new Stop('syntax error: unterminated array')
			const char = src[i] as string
			if (char === ' ' || char === '\t' || char === '\n') {
				i += 1
				continue
			}
			if (char === '#') {
				while (i < src.length && src[i] !== '\n') i += 1
				continue
			}
			if (char === ')') {
				builder.expansion(src.slice(from - 1, i + 1))
				return i + 1
			}
			if (
				WORD_BREAK.has(char) &&
				!((char === '<' || char === '>') && src[this.cont(i + 1)] === '(')
			) {
				throw new Stop('syntax error in array')
			}
			const element = this.word(i)
			if (element.kind !== 'word') throw new Stop('syntax error in array')
			const subscript = /^\[([^\]]*)\]\+?=/.exec(element.word.text)
			if (subscript && !/^\d*$/.test(subscript[1] as string))
				this.context.opaque('arithmetic subscript')
			i = element.end
		}
	}

	/** After the `[` of `NAME[`: returns the offset past the matching `]`. */
	private subscript(from: number): number {
		const src = this.src
		const scratch = new WordBuilder()
		let depth = 0
		let i = from
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) throw new Stop('syntax error: unterminated subscript')
			const char = src[i] as string
			if (char === '\\') {
				i += 2
				continue
			}
			if (char === "'") {
				const close = src.indexOf("'", i + 1)
				if (close < 0) throw new Stop('unterminated quote')
				this.singleQuoted(i, close)
				i = close + 1
				continue
			}
			if (char === '"') {
				i = this.doubleQuoted(i + 1, scratch)
				continue
			}
			if (char === '`') {
				i = this.backtick(i, scratch, false)
				continue
			}
			if (char === '$') {
				i = this.dollar(i, scratch, false)
				continue
			}
			if ((char === '<' || char === '>') && src[this.cont(i + 1)] === '(') {
				// Measured: `b[<(cmd)]` runs `cmd`.
				i = this.processSubstitution(i, scratch)
				continue
			}
			if (char === '[') depth += 1
			else if (char === ']') {
				if (depth === 0) return i + 1
				depth -= 1
			}
			i += 1
		}
	}

	/** After an opening `"`: returns the offset past the closing one. */
	private doubleQuoted(from: number, builder: WordBuilder): number {
		const src = this.src
		let i = from
		builder.quotedText('')
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) throw new Stop('unterminated quote')
			const char = src[i] as string
			if (char === '"') return i + 1
			if (char === '\\') {
				const next = src[i + 1]
				if (next === '$' || next === '`' || next === '"' || next === '\\') {
					builder.quotedText(next)
					i += 2
					continue
				}
				builder.quotedText('\\')
				i += 1
				continue
			}
			if (char === '$') {
				i = this.dollar(i, builder, true)
				continue
			}
			if (char === '`') {
				i = this.backtick(i, builder, true)
				continue
			}
			builder.quotedText(char)
			i += 1
		}
	}

	/** A `$` at `at`. Returns the offset past whatever it introduces. */
	dollar(at: number, builder: WordBuilder, inDouble: boolean): number {
		const src = this.src
		const n = this.cont(at + 1)
		const next = src[n]
		if (next === "'" && !inDouble) {
			this.bashOnly("$'…'")
			return this.ansiC(n + 1, builder)
		}
		if (next === '"' && !inDouble) {
			this.bashOnly('$"…"')
			// `$"…"` is translated through the message catalogue at runtime.
			const inner = new WordBuilder()
			const end = this.doubleQuoted(n + 1, inner)
			builder.expansion(src.slice(at, end))
			builder.quoted = true
			if (inner.expands) builder.expands = true
			return end
		}
		if (next === '{') {
			const n2 = this.cont(n + 1)
			const inner = src[n2]
			if (inner === ' ' || inner === '\t' || inner === '\n' || inner === '|') {
				// Bash 5.3's `${ list; }` and `${| list; }`: a command
				// substitution that runs in the current shell.
				this.context.opaque('command substitution')
				const parser = new Parser(
					src,
					inner === '|' ? n2 + 1 : n2,
					this.context,
					'substitution',
					this.depth,
					this.nestingNow + 1,
				)
				const end = parser.braceSubstitution()
				builder.expansion(src.slice(at, end))
				return end
			}
			const end = this.parameterBraces(n + 1, inDouble)
			builder.expansion(src.slice(at, end))
			return end
		}
		if (next === '(') {
			const n2 = this.cont(n + 1)
			if (src[n2] === '(') {
				const end = this.scanArithmetic(n2 + 1)
				if (end >= 0) {
					this.arithmeticContent(src.slice(n2 + 1, end - 2), n2 + 1)
					builder.expansion(src.slice(at, end))
					return end
				}
			}
			this.context.opaque('command substitution')
			const inner = new Parser(
				src,
				n + 1,
				this.context,
				'substitution',
				this.depth,
				this.nestingNow + 1,
			)
			const end = inner.substitution()
			builder.expansion(src.slice(at, end))
			return end
		}
		if (next === '[') {
			this.bashOnly('$[…]')
			const end = this.matchBracket(n + 1)
			this.arithmeticContent(src.slice(n + 1, end - 1), n + 1)
			builder.expansion(src.slice(at, end))
			return end
		}
		if (next !== undefined && NAME_START.test(next)) {
			let i = n + 1
			for (;;) {
				i = this.cont(i)
				if (i < src.length && NAME_CHAR.test(src[i] as string)) i += 1
				else break
			}
			builder.expansion(src.slice(at, i))
			return i
		}
		if (next === '$' && inDouble) {
			// Bash's parser pairs `$$` inside double quotes, so a `(` or `{`
			// after it is literal text as far as the extent of the string goes.
			// Its expander does not: it re-scans the string and reads the
			// second `$` as the start of `$(…)` or `${…}`, and so
			// `"$${x:-"'$(cmd)'"}"` runs `cmd`, which the parse had seen as
			// single-quoted. Nothing read from the source can say what that
			// runs, so the line is opaque.
			const after = src[this.cont(n + 1)]
			if (after === '(' || after === '{') this.context.opaque('$$ before ( or { in double quotes')
		}
		if (next !== undefined && /[0-9$?!#@*-]/.test(next)) {
			builder.expansion(src.slice(at, n + 1))
			return n + 1
		}
		// A lone `$` is literal.
		if (inDouble) builder.quotedText('$')
		else builder.unquoted('$')
		return at + 1
	}

	/** `$[…]`: returns the offset past the matching `]`. */
	private matchBracket(from: number): number {
		const src = this.src
		let depth = 0
		let i = from
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) throw new Stop('unterminated $[')
			const char = src[i] as string
			if (char === '\\') {
				i += 2
				continue
			}
			if (char === '[') depth += 1
			else if (char === ']') {
				if (depth === 0) return i + 1
				depth -= 1
			}
			i += 1
		}
	}

	/**
	 * After `${`: returns the offset past the matching `}`. The content is
	 * checked against the forms whose evaluation runs nothing; anything else
	 * (indirection, a subscript or offset evaluated as arithmetic, a
	 * transformation) is opaque.
	 */
	private parameterBraces(from: number, inDouble: boolean): number {
		const src = this.src
		let i = from
		const scratch = new WordBuilder()
		for (;;) {
			i = this.cont(i)
			if (i >= src.length) throw new Stop('unterminated ${')
			const char = src[i] as string
			if (char === '}') break
			if (char === '\\') {
				i += 2
				continue
			}
			if (char === "'") {
				if (inDouble) {
					// Whether a single quote inside `${…}` inside double quotes
					// quotes depends on the operator and the shell's mode.
					this.context.opaque('single quote in parameter expansion')
					i += 1
					continue
				}
				const close = src.indexOf("'", i + 1)
				if (close < 0) throw new Stop('unterminated quote')
				this.singleQuoted(i, close)
				i = close + 1
				continue
			}
			if (char === '"') {
				i = this.doubleQuoted(i + 1, scratch)
				continue
			}
			if (char === '`') {
				i = this.backtick(i, scratch, inDouble)
				continue
			}
			if (char === '$') {
				i = this.dollar(i, scratch, inDouble)
				continue
			}
			if ((char === '<' || char === '>') && src[this.cont(i + 1)] === '(') {
				// Measured: unquoted, `${x:-<(cmd)}` runs `cmd`. Inside double
				// quotes bash still parses it, and rejects a malformed one.
				i = this.processSubstitution(i, scratch)
				continue
			}
			i += 1
		}
		const content = src.slice(from, i).replace(/\\\n/g, '')
		if (!SAFE_PARAMETER.test(content)) this.context.opaque('parameter expansion')
		else if (!POSIX_PARAMETER.test(content)) this.bashOnly('parameter expansion')
		return i + 1
	}

	/** After `$'`: decode to the closing quote. */
	private ansiC(from: number, builder: WordBuilder): number {
		const src = this.src
		let i = from
		let decoded = ''
		let exact = true
		for (;;) {
			if (i >= src.length) throw new Stop('unterminated quote')
			const char = src[i] as string
			if (char === "'") break
			if (char !== '\\') {
				decoded += char
				i += 1
				continue
			}
			const letter = src[i + 1]
			if (letter === undefined) throw new Stop('unterminated quote')
			i += 2
			const simple = ANSI_C_SIMPLE[letter]
			if (simple !== undefined) {
				decoded += simple
				continue
			}
			if (letter >= '0' && letter <= '7') {
				let digits = letter
				while (digits.length < 3 && /[0-7]/.test(src[i] ?? '')) {
					digits += src[i]
					i += 1
				}
				const code = Number.parseInt(digits, 8) & 0xff
				if (code === 0 || code > 0x7f) exact = false
				decoded += String.fromCharCode(code)
				continue
			}
			if (letter === 'x' && src[i] === '{') {
				// `\x{HHH…}`: any number of digits, the closing brace optional,
				// the value truncated to a byte.
				i += 1
				let digits = ''
				while (/[0-9A-Fa-f]/.test(src[i] ?? '')) {
					digits += src[i]
					i += 1
				}
				if (src[i] === '}') i += 1
				const code = digits === '' ? 0 : Number.parseInt(digits.slice(-2), 16)
				if (code === 0 || code > 0x7f) exact = false
				decoded += String.fromCharCode(code)
				continue
			}
			if (letter === 'x') {
				let digits = ''
				while (digits.length < 2 && /[0-9A-Fa-f]/.test(src[i] ?? '')) {
					digits += src[i]
					i += 1
				}
				if (digits === '') {
					decoded += '\\x'
					continue
				}
				const code = Number.parseInt(digits, 16)
				if (code === 0 || code > 0x7f) exact = false
				decoded += String.fromCharCode(code)
				continue
			}
			if (letter === 'u' || letter === 'U') {
				const max = letter === 'u' ? 4 : 8
				let digits = ''
				while (digits.length < max && /[0-9A-Fa-f]/.test(src[i] ?? '')) {
					digits += src[i]
					i += 1
				}
				if (digits === '') {
					decoded += `\\${letter}`
					continue
				}
				const code = Number.parseInt(digits, 16)
				// Beyond ASCII the result depends on the locale's encoding.
				if (code === 0 || code > 0x7f) exact = false
				decoded += code <= 0x10ffff ? String.fromCodePoint(code) : ''
				continue
			}
			if (letter === 'c') {
				const target = src[i]
				if (target === undefined || target === "'") {
					// `\c` with nothing to control: bash keeps it.
					decoded += '\\c'
					continue
				}
				i += 1
				if (target === '\\' && src[i] === '\\') i += 1
				const code = target === '?' ? 0x7f : target.toUpperCase().charCodeAt(0) & 0x1f
				if (code === 0 || target.charCodeAt(0) > 0x7f) exact = false
				decoded += String.fromCharCode(code)
				continue
			}
			// Unknown escapes stay as written.
			decoded += `\\${letter}`
		}
		this.singleQuoted(from - 1, i)
		builder.quotedText(decoded)
		if (!exact) builder.expands = true
		return i + 1
	}

	/**
	 * A backtick substitution starting at `at`. The body is unescaped the way
	 * bash does it and read as a command line of its own. Returns the offset
	 * past the closing backtick.
	 */
	backtick(at: number, builder: WordBuilder, inDouble: boolean): number {
		const src = this.src
		let i = at + 1
		let body = ''
		for (;;) {
			if (i >= src.length) throw new Stop('unterminated backtick')
			const char = src[i] as string
			if (char === '`') break
			if (char === '\\') {
				const next = src[i + 1]
				if (next === '$' || next === '`' || next === '\\' || (inDouble && next === '"')) {
					body += next
					i += 2
					continue
				}
				body += char
				i += 1
				continue
			}
			body += char
			i += 1
		}
		this.context.opaque('command substitution')
		builder.expansion(src.slice(at, i + 1))
		this.context.rescan(body.length)
		this.inherit(body)
		const inner = new Parser(body, 0, this.context, 'substitution', this.depth, this.nestingNow + 1)
		try {
			inner.program()
		} catch (error) {
			if (!(error instanceof Stop)) throw error
		}
		return i + 1
	}

	/** `<(…)` or `>(…)` at `at`. */
	private processSubstitution(at: number, builder: WordBuilder): number {
		const open = this.cont(at + 1)
		this.context.opaque('process substitution')
		const inner = new Parser(
			this.src,
			open + 1,
			this.context,
			'substitution',
			this.depth,
			this.nestingNow + 1,
		)
		const end = inner.substitution()
		builder.expansion(this.src.slice(at, end))
		return end
	}
}

/**
 * `${…}` contents that evaluate nothing but a parameter: a name, a positional
 * or special parameter, optionally its length, a literal subscript, a literal
 * substring offset, or one of the default/assign/error/alternative, pattern
 * removal, substitution and case operators followed by any word (the word
 * was already read for substitutions).
 */
const SAFE_PARAMETER =
	/^(?:#?(?:[A-Za-z_][A-Za-z0-9_]*(?:\[(?:\d+|@|\*)\])?|\d+|[@*#?$!-])(?:(?::?[-=+?]|##?|%%?|\/[/#%]?|\^\^?|,,?)[\s\S]*|:\s*-?\d+\s*(?::\s*-?\d+\s*)?)?)$/

/**
 * `${…}` forms POSIX defines, with a word free of quotes and escapes, whose
 * handling inside `${…}` differs between shells.
 */
const POSIX_PARAMETER =
	/^(?:#?(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])|(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])(?::?[-=+?]|##?|%%?)[^'"\\`]*)$/

const ANSI_C_SIMPLE: Readonly<Record<string, string>> = {
	a: '\x07',
	b: '\b',
	e: '\x1b',
	E: '\x1b',
	f: '\f',
	n: '\n',
	r: '\r',
	t: '\t',
	v: '\v',
	'\\': '\\',
	"'": "'",
	'"': '"',
	'?': '?',
}

/** Source text with its line continuations removed, as bash reads it. */
function joined(text: string): string {
	return text.includes('\\\n') ? text.replace(/\\\n/g, '') : text
}

function trailingBackslashes(text: string): number {
	let count = 0
	for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i -= 1) count += 1
	return count
}

export function basename(word: string): string {
	const cut = word.lastIndexOf('/')
	return cut < 0 ? word : word.slice(cut + 1)
}
