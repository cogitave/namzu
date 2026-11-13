/**
 * Syntax colour for the code blocks of a reply.
 *
 * The colouring is done by the open-source library highlight.js, which is read in
 * pieces: its small core and then one grammar per language, each behind its own
 * dynamic `import()` so that each is a file of its own in the bundle and nothing of
 * it is loaded before a reply holds a block in that language. A person who never sees
 * a fenced block never pays for any of it.
 *
 * ## What this module promises
 *
 * - **The text is never touched.** What comes back is the line it was given, cut into
 *   runs; the runs put together are exactly the line. When the library hands back
 *   anything else the block is drawn plain (see {@link colourLines}).
 * - **Loading is not a race anyone can see.** {@link grammarState} says `loading` until
 *   the grammar has arrived or has failed, and the printing side holds a block's rows
 *   for as long as that lasts (never more than {@link GRAMMAR_WAIT_MS}). A grammar that
 *   cannot be read, or throws, is plain for the rest of the session, with nothing said.
 * - **The cost is bounded.** A block is cut into windows and a window is only extended
 *   while the library is inside something that has not closed (a comment, a template,
 *   a docstring). Three prefix rules (one line, one block, one reply) end the colouring
 *   at a line; every one of them is a rule about what is above a line, so a line gets
 *   the same colours whether the block was drawn whole or one part at a time.
 *
 * ## The set of languages
 *
 * The library's own "common" set (the grammars its default build ships), plus
 * `dockerfile` and `powershell`, and the short names people write after the fence.
 * Every grammar listed here has been run against the stress inputs in
 * `code-highlight-stress.test.ts`; adding one means adding it there first. The grammars
 * that a grammar embeds (`xml` in `markdown`, `bash` in a shell session) are loaded
 * with it; the ones it only embeds for tagged templates (CSS, GraphQL and HTML inside a
 * JavaScript template literal) are not loaded, and that text stays in the normal colour.
 *
 * Pure apart from the module state that holds what has been loaded.
 */

import type { HLJSApi, LanguageFn } from 'highlight.js'

/** What a run of code is, as far as colour goes. Everything else is the normal text colour. */
export type CodeKind =
	| 'keyword'
	| 'string'
	| 'number'
	| 'comment'
	| 'name'
	| 'type'
	| 'literal'
	| 'added'
	| 'removed'

/** A run of one line, in one kind (or none: the normal colour). */
export interface CodeRun {
	readonly text: string
	readonly kind?: CodeKind
}

/** One line of code as runs; the runs put together are the line. */
export type CodeLine = readonly CodeRun[]

/**
 * What a reply's drawing of one code block starts from. It is carried from one printed
 * part of a reply to the next, because a part is drawn on its own and cannot look at the
 * lines above it.
 */
export interface CodeFlow {
	/**
	 * The lines of the open block that the library has to read again to colour the next
	 * ones: from the last line the library was between tokens on, to the end of what has
	 * been printed. Empty most of the time. `STOPPED` once an open construct has outgrown
	 * {@link OPEN_LIMIT}.
	 */
	readonly above: string
	/** Characters of fenced code in the reply before this part. */
	readonly spent: number
	/** Characters of the open block before this part. */
	readonly block: number
}

export const NO_FLOW: CodeFlow = { above: '', spent: 0, block: 0 }

/** The `above` of a block whose colouring has ended: the rest of it is drawn plain. */
export const STOPPED = '\u0000stopped'

// ── The limits ───────────────────────────────────────────────────────────────────────

/** A line longer than this ends the colouring of its block (it is minified or a data blob). */
export const MAX_LINE_CHARS = 400
/** A line with an unbroken run of word characters longer than this is a blob, not code. */
export const MAX_WORD_RUN = 100
/** Characters of one block that are coloured; the rest is drawn plain. */
export const MAX_BLOCK_CHARS = 80_000
/** Characters of fenced code in one reply that are coloured. */
export const MAX_REPLY_CHARS = 250_000
/** The longest stretch of an unclosed comment, string or template that is followed. */
export const OPEN_LIMIT = 8_000
/** Lines, and characters, the library reads at a time. */
const WINDOW_LINES = 32
const WINDOW_CHARS = 4_000
/** Lines read past a window's end before it is closed, to see that what is above does not depend on them. */
const LOOKAHEAD_LINES = 8
/** The longest a block may wait for its grammar before it is drawn plain for good. */
export const GRAMMAR_WAIT_MS = 1_500

/**
 * Grammars whose expressions backtrack on a long line of a kind a person never writes get a
 * shorter line limit than the rest: with `a.a.a.a…` the INI grammar (which draws TOML too)
 * took 64 ms for one 400-character line.
 */
const LINE_LIMITS: Partial<Record<GrammarId, number>> = { ini: 100 }

const WORD_BLOB = new RegExp(`[\\p{L}\\p{N}_]{${MAX_WORD_RUN + 1}}`, 'u')

/**
 * How many leading lines of `lines` are inside the limits, given what the reply and the
 * block have spent above them. Pure: the answer for a line depends only on what is above it.
 */
export function colourableLines(
	lines: readonly string[],
	flow: Pick<CodeFlow, 'spent' | 'block'> = NO_FLOW,
	word?: string,
): number {
	const id = grammarOf(word)
	const lineLimit = (id !== undefined ? LINE_LIMITS[id] : undefined) ?? MAX_LINE_CHARS
	let spent = flow.spent
	let block = flow.block
	for (let i = 0; i < lines.length; i++) {
		const length = (lines[i] as string).length
		spent += length + 1
		block += length + 1
		if (
			length > lineLimit ||
			block > MAX_BLOCK_CHARS ||
			spent > MAX_REPLY_CHARS ||
			(length > MAX_WORD_RUN && WORD_BLOB.test(lines[i] as string))
		)
			return i
	}
	return lines.length
}

// ── Languages ────────────────────────────────────────────────────────────────────────

type Module = { readonly default: LanguageFn }

/** One loader per grammar, each a literal `import()` so the bundler makes a chunk of it. */
const LOADERS = {
	bash: () => import('highlight.js/lib/languages/bash'),
	c: () => import('highlight.js/lib/languages/c'),
	cpp: () => import('highlight.js/lib/languages/cpp'),
	csharp: () => import('highlight.js/lib/languages/csharp'),
	css: () => import('highlight.js/lib/languages/css'),
	diff: () => import('highlight.js/lib/languages/diff'),
	dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
	go: () => import('highlight.js/lib/languages/go'),
	graphql: () => import('highlight.js/lib/languages/graphql'),
	ini: () => import('highlight.js/lib/languages/ini'),
	java: () => import('highlight.js/lib/languages/java'),
	javascript: () => import('highlight.js/lib/languages/javascript'),
	json: () => import('highlight.js/lib/languages/json'),
	kotlin: () => import('highlight.js/lib/languages/kotlin'),
	less: () => import('highlight.js/lib/languages/less'),
	lua: () => import('highlight.js/lib/languages/lua'),
	makefile: () => import('highlight.js/lib/languages/makefile'),
	markdown: () => import('highlight.js/lib/languages/markdown'),
	objectivec: () => import('highlight.js/lib/languages/objectivec'),
	perl: () => import('highlight.js/lib/languages/perl'),
	php: () => import('highlight.js/lib/languages/php'),
	'php-template': () => import('highlight.js/lib/languages/php-template'),
	powershell: () => import('highlight.js/lib/languages/powershell'),
	python: () => import('highlight.js/lib/languages/python'),
	'python-repl': () => import('highlight.js/lib/languages/python-repl'),
	r: () => import('highlight.js/lib/languages/r'),
	ruby: () => import('highlight.js/lib/languages/ruby'),
	rust: () => import('highlight.js/lib/languages/rust'),
	scss: () => import('highlight.js/lib/languages/scss'),
	shell: () => import('highlight.js/lib/languages/shell'),
	sql: () => import('highlight.js/lib/languages/sql'),
	swift: () => import('highlight.js/lib/languages/swift'),
	typescript: () => import('highlight.js/lib/languages/typescript'),
	vbnet: () => import('highlight.js/lib/languages/vbnet'),
	wasm: () => import('highlight.js/lib/languages/wasm'),
	xml: () => import('highlight.js/lib/languages/xml'),
	yaml: () => import('highlight.js/lib/languages/yaml'),
} as const satisfies Record<string, () => Promise<Module>>

export type GrammarId = keyof typeof LOADERS

/** Grammars a grammar reads inside itself, loaded with it. */
const EMBEDS: Partial<Record<GrammarId, readonly GrammarId[]>> = {
	markdown: ['xml'],
	dockerfile: ['bash'],
	shell: ['bash'],
	'python-repl': ['python'],
	'php-template': ['php', 'xml'],
}

/** The names that mean no colour: drawn as a block without a language. */
const PLAIN_NAMES = new Set(['text', 'txt', 'plain', 'plaintext', 'none', 'output', 'log'])

/** What people write after the fence, to the grammar that draws it. */
const NAMES: Readonly<Record<string, GrammarId>> = {
	bash: 'bash',
	sh: 'bash',
	zsh: 'bash',
	shellscript: 'bash',
	c: 'c',
	h: 'c',
	cpp: 'cpp',
	cc: 'cpp',
	'c++': 'cpp',
	'h++': 'cpp',
	hpp: 'cpp',
	hh: 'cpp',
	hxx: 'cpp',
	cxx: 'cpp',
	csharp: 'csharp',
	cs: 'csharp',
	'c#': 'csharp',
	css: 'css',
	diff: 'diff',
	patch: 'diff',
	dockerfile: 'dockerfile',
	docker: 'dockerfile',
	go: 'go',
	golang: 'go',
	graphql: 'graphql',
	gql: 'graphql',
	ini: 'ini',
	toml: 'ini',
	java: 'java',
	jsp: 'java',
	javascript: 'javascript',
	js: 'javascript',
	jsx: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	jsonc: 'json',
	kotlin: 'kotlin',
	kt: 'kotlin',
	kts: 'kotlin',
	less: 'less',
	lua: 'lua',
	makefile: 'makefile',
	make: 'makefile',
	mk: 'makefile',
	markdown: 'markdown',
	md: 'markdown',
	mkd: 'markdown',
	objectivec: 'objectivec',
	objc: 'objectivec',
	'objective-c': 'objectivec',
	perl: 'perl',
	pl: 'perl',
	pm: 'perl',
	php: 'php',
	'php-template': 'php-template',
	powershell: 'powershell',
	pwsh: 'powershell',
	ps1: 'powershell',
	python: 'python',
	py: 'python',
	python3: 'python',
	'python-repl': 'python-repl',
	pycon: 'python-repl',
	r: 'r',
	ruby: 'ruby',
	rb: 'ruby',
	rust: 'rust',
	rs: 'rust',
	scss: 'scss',
	shell: 'shell',
	console: 'shell',
	shellsession: 'shell',
	sql: 'sql',
	swift: 'swift',
	typescript: 'typescript',
	ts: 'typescript',
	tsx: 'typescript',
	mts: 'typescript',
	cts: 'typescript',
	vbnet: 'vbnet',
	vb: 'vbnet',
	wasm: 'wasm',
	xml: 'xml',
	html: 'xml',
	xhtml: 'xml',
	svg: 'xml',
	plist: 'xml',
	yaml: 'yaml',
	yml: 'yaml',
}

/** Every language word this module draws in colour. */
export const KNOWN_LANGUAGE_WORDS: readonly string[] = Object.keys(NAMES)

/** The grammar a fence's language word names, or `undefined` for none, an unknown word or a plain-text one. */
export function grammarOf(word: string | undefined): GrammarId | undefined {
	if (word === undefined) return undefined
	const first =
		word
			.trim()
			.split(/[:{,=\s]/u)[0]
			?.toLowerCase() ?? ''
	if (first === '' || PLAIN_NAMES.has(first)) return undefined
	return Object.hasOwn(NAMES, first) ? NAMES[first] : undefined
}

// ── Whether colour is drawn at all ───────────────────────────────────────────────────

let enabled = true

/** `tui.syntaxHighlight`: false draws every code block as it was drawn before there was colour. */
export function setSyntaxHighlight(on: boolean): void {
	if (enabled === on) return
	enabled = on
	changed()
}

export function syntaxHighlightOn(): boolean {
	return enabled
}

/**
 * Whether code is coloured on this terminal: not under `NO_COLOR`, `FORCE_COLOR=0`, a
 * dumb terminal, a CI run that did not force colour, or where nothing is drawn on a
 * terminal at all. Where it is false no highlighting is done, not just no colour written.
 */
export function colourWanted(
	env: NodeJS.ProcessEnv = process.env,
	isTty: boolean = process.stdout.isTTY === true,
): boolean {
	if ((env.NO_COLOR ?? '') !== '' || env.FORCE_COLOR === '0' || env.TERM === 'dumb') return false
	const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== ''
	if (!forced && (env.CI ?? '') !== '') return false
	return forced || isTty
}

// ── Loading ──────────────────────────────────────────────────────────────────────────

type Loading =
	| { readonly status: 'loading'; readonly settled: Promise<void> }
	| { readonly status: 'ready' }
	| { readonly status: 'failed' }

const states = new Map<GrammarId, Loading>()
const listeners = new Set<() => void>()
let version = 0
let core: HLJSApi | undefined
let corePromise: Promise<HLJSApi | undefined> | undefined
const roots = new Map<GrammarId, unknown>()
let loaders: Readonly<Record<GrammarId, () => Promise<Module>>> = LOADERS
let waitMs = GRAMMAR_WAIT_MS

function changed(): void {
	version++
	for (const listener of [...listeners]) {
		try {
			listener()
		} catch {
			// A listener is a redraw; it must not break the loader.
		}
	}
}

/** For `useSyncExternalStore`: called when a grammar has arrived, has failed, or the setting changed. */
export function subscribeGrammars(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

/** Changes whenever {@link subscribeGrammars} would call back. */
export function grammarVersion(): number {
	return version
}

function loadCore(): Promise<HLJSApi | undefined> {
	corePromise ??= import('highlight.js/lib/core').then(
		(m) => {
			core = m.default
			return core
		},
		() => undefined,
	)
	return corePromise
}

/**
 * Run `fn` with the console silent, and say whether anything was written to it. The
 * library reports a grammar that fails with `console.error`, which would land on the
 * person's screen between the rows; a failed grammar is plain, and nothing is said.
 */
function quiet<T>(fn: () => T): { value: T | undefined; spoke: boolean; threw: boolean } {
	const saved = { error: console.error, warn: console.warn, log: console.log }
	let spoke = false
	const mute = (): void => {
		spoke = true
	}
	console.error = mute
	console.warn = mute
	console.log = mute
	try {
		return { value: fn(), spoke, threw: false }
	} catch {
		return { value: undefined, spoke, threw: true }
	} finally {
		console.error = saved.error
		console.warn = saved.warn
		console.log = saved.log
	}
}

async function loadOne(id: GrammarId): Promise<boolean> {
	const hljs = await loadCore()
	if (!hljs) return false
	try {
		const loaded = await loaders[id]()
		const registered = quiet(() => hljs.registerLanguage(id, loaded.default))
		return !registered.spoke && !registered.threw && hljs.getLanguage(id) !== undefined
	} catch {
		return false
	}
}

/**
 * Start reading a grammar if it is not read yet. Never throws and never rejects; the
 * answer is {@link grammarState}. After {@link GRAMMAR_WAIT_MS} a grammar that has not
 * arrived is failed for the session, whatever happens to the read after that.
 */
function start(id: GrammarId): Loading {
	const known = states.get(id)
	if (known) return known
	let timer: ReturnType<typeof setTimeout> | undefined
	const settle = (ok: boolean): void => {
		if (states.get(id)?.status !== 'loading') return
		if (timer !== undefined) clearTimeout(timer)
		states.set(id, { status: ok ? 'ready' : 'failed' })
		changed()
	}
	const settled = new Promise<void>((resolve) => {
		const done = (ok: boolean): void => {
			settle(ok)
			resolve()
		}
		timer = setTimeout(() => done(false), waitMs)
		timer.unref?.()
		const all = [id, ...(EMBEDS[id] ?? [])]
		Promise.all(all.map((one) => loadOne(one))).then(
			(results) => done(results[0] === true),
			() => done(false),
		)
	})
	const loading: Loading = { status: 'loading', settled }
	states.set(id, loading)
	return loading
}

/**
 * Whether a block that names `word` is drawn in colour now (`ready`), waits for its
 * grammar (`loading`: the printing side holds its rows), or is drawn plain (`plain`:
 * no such language, plain text, the setting off, no colour on this terminal, or a
 * grammar that could not be read). Asking starts the read.
 */
export function grammarState(word: string | undefined): 'plain' | 'loading' | 'ready' {
	if (!enabled || !colourWanted()) return 'plain'
	const id = grammarOf(word)
	if (id === undefined) return 'plain'
	const state = start(id)
	return state.status === 'failed' ? 'plain' : state.status
}

/** Resolves when every grammar the words name has arrived or failed. Never rejects. */
export async function whenGrammarsSettle(words: Iterable<string | undefined>): Promise<void> {
	const waits: Promise<void>[] = []
	for (const word of words) {
		if (!enabled || !colourWanted()) return
		const id = grammarOf(word)
		if (id === undefined) continue
		const state = start(id)
		if (state.status === 'loading') waits.push(state.settled)
	}
	await Promise.all(waits)
}

/**
 * The language words of the fenced blocks in a piece of Markdown source, for loading
 * them before it is printed. Cheap: nothing is parsed, a line is looked at only when it
 * begins with a fence.
 */
export function languagesIn(source: string): string[] {
	if (!source.includes('```') && !source.includes('~~~')) return []
	const found = new Set<string>()
	for (const match of source.matchAll(/^[ \t]*(?:`{3,}|~{3,})[ \t]*([^\s`~]+)/gmu)) {
		if (match[1] !== undefined) found.add(match[1])
	}
	return [...found]
}

// ── Reading the library's output ─────────────────────────────────────────────────────

const ENTITIES: Readonly<Record<string, string>> = {
	'&amp;': '&',
	'&lt;': '<',
	'&gt;': '>',
	'&quot;': '"',
	'&#x27;': "'",
	'&#39;': "'",
}
const unescapeHtml = (text: string): string =>
	text.includes('&')
		? text.replace(/&(?:amp|lt|gt|quot|#x27|#39);/gu, (m) => ENTITIES[m] ?? m)
		: text

/** The kind a scope of the library draws as: `undefined` inherits, `null` is the normal colour. */
function kindOfScope(scope: string): CodeKind | null | undefined {
	switch (scope) {
		case 'keyword':
		case 'variable-language':
		case 'name':
		case 'selector-tag':
		case 'tag':
		case 'meta':
		case 'section':
		case 'bullet':
		case 'selector-id':
		case 'selector-class':
		case 'selector-attr':
		case 'selector-pseudo':
		case 'meta-keyword':
			return 'keyword'
		case 'string':
		case 'code':
		case 'regexp':
		case 'meta-string':
		case 'link':
		case 'template-tag':
		case 'template-variable':
			return 'string'
		case 'number':
			return 'number'
		case 'comment':
		case 'doctag':
		case 'quote':
			return 'comment'
		case 'literal':
		case 'symbol':
			return 'literal'
		case 'title':
		case 'title-function':
		case 'title-function-invoke':
		case 'attr':
		case 'attribute':
		case 'property':
			return 'name'
		case 'title-class':
		case 'title-class-inherited':
		case 'type':
		case 'built_in':
			return 'type'
		case 'addition':
			return 'added'
		case 'deletion':
			return 'removed'
		case 'subst':
		case 'function':
		case 'class':
		case 'params':
		case 'operator':
		case 'punctuation':
			return null
		default:
			return undefined
	}
}

/** `hljs-title function_` is the scope `title-function`; `hljs-keyword` is `keyword`. */
function scopeOf(classes: string): string {
	const parts = classes.split(/\s+/u).filter((p) => p !== '')
	let scope = ''
	for (const part of parts) {
		if (part.startsWith('hljs-')) scope = part.slice(5)
		else if (part.endsWith('_') && scope !== '') scope += `-${part.slice(0, -1)}`
	}
	return scope
}

/**
 * The library's HTML as lines of runs. The HTML holds only `<span class>`, `</span>` and
 * text with five escaped characters, so it is read with a scanner rather than a parser.
 * A span may run across lines (a block comment): the kind stays open over the break.
 * Returns `undefined` when what it read is not exactly `code`.
 */
function runsOf(html: string, code: string): CodeLine[] | undefined {
	const stack: (CodeKind | null | undefined)[] = []
	const lines: CodeRun[][] = [[]]
	let rebuilt = ''
	const kind = (): CodeKind | undefined => {
		for (let i = stack.length - 1; i >= 0; i--) {
			const k = stack[i]
			if (k === null) return undefined
			if (k !== undefined) return k
		}
		return undefined
	}
	const push = (text: string): void => {
		const current = kind()
		const line = lines[lines.length - 1] as CodeRun[]
		const last = line[line.length - 1]
		if (last !== undefined && last.kind === current) {
			line[line.length - 1] = { text: last.text + text, ...(current ? { kind: current } : {}) }
		} else line.push(current ? { text, kind: current } : { text })
	}
	const scan = /<span class="([^"]*)">|<\/span>|([^<]+)/gu
	for (const match of html.matchAll(scan)) {
		if (match[1] !== undefined) stack.push(kindOfScope(scopeOf(match[1])))
		else if (match[2] === undefined) stack.pop()
		else {
			const text = unescapeHtml(match[2])
			rebuilt += text
			const pieces = text.split('\n')
			pieces.forEach((piece, i) => {
				if (i > 0) lines.push([])
				if (piece !== '') push(piece)
			})
		}
	}
	return rebuilt === code ? lines : undefined
}

let observer: ((id: GrammarId, chars: number, ms: number) => void) | undefined

/** For measuring: called after every call of the library with its size and its time. */
export function observeLibraryCalls(
	fn: ((id: GrammarId, chars: number, ms: number) => void) | undefined,
): void {
	observer = fn
}

/** One call of the library over `code`, as lines of runs and whether it ended between tokens. */
function highlightOnce(
	id: GrammarId,
	code: string,
): { lines: CodeLine[]; atRest: boolean } | undefined {
	if (!core) return undefined
	const hljs = core
	const attempt = quiet(() => readOnce(hljs, id, code))
	if (attempt.threw || attempt.spoke || attempt.value === 'failed') {
		// A grammar that throws, or complains, is plain for the session; nothing is said.
		states.set(id, { status: 'failed' })
		changed()
		return undefined
	}
	return attempt.value as { lines: CodeLine[]; atRest: boolean } | undefined
}

function readOnce(
	hljs: HLJSApi,
	id: GrammarId,
	code: string,
): { lines: CodeLine[]; atRest: boolean } | undefined | 'failed' {
	let root = roots.get(id)
	if (root === undefined) {
		root = (hljs.highlight('', { language: id, ignoreIllegals: true }) as { _top?: unknown })._top
		roots.set(id, root)
	}
	const began = observer ? performance.now() : 0
	const result = hljs.highlight(code, { language: id, ignoreIllegals: true }) as {
		value: string
		_top?: unknown
		errorRaised?: unknown
	}
	observer?.(id, code.length, performance.now() - began)
	if (result.errorRaised !== undefined) return 'failed'
	const lines = runsOf(result.value, code)
	if (!lines) return undefined
	return { lines, atRest: result._top !== undefined && result._top === root }
}

// ── Colouring a block ────────────────────────────────────────────────────────────────

export interface Coloured {
	/**
	 * The runs of the leading lines of the block, as many as the limits allow (and an
	 * unclosed construct longer than {@link OPEN_LIMIT} ends them early). The lines after
	 * are drawn plain.
	 */
	readonly lines: readonly CodeLine[]
	/** What the next part of the block starts from, if the block goes on. */
	readonly above: string
}

interface Read {
	/** Runs of every line read so far, the last window's included. */
	runs: CodeLine[]
	/** The first line of the last window: the library was between tokens before it. */
	start: number
	/** Whether the library was between tokens at the end of the last window. */
	atRest: boolean
	/** An unclosed construct outgrew {@link OPEN_LIMIT}: no more lines are coloured. */
	stopped: boolean
}

/** Whether the first `count` lines of two reads are the same runs. */
function sameLines(a: readonly CodeLine[], b: readonly CodeLine[], count: number): boolean {
	for (let i = 0; i < count; i++) {
		const x = a[i]
		const y = b[i]
		if (!x || !y || x.length !== y.length) return false
		for (let j = 0; j < x.length; j++) {
			if (
				(x[j] as CodeRun).text !== (y[j] as CodeRun).text ||
				(x[j] as CodeRun).kind !== (y[j] as CodeRun).kind
			)
				return false
		}
	}
	return true
}

/**
 * Read `source` in windows. A window is closed, and never read again, at a line where the
 * library is between tokens and where the lines before it come out the same whether or not
 * the {@link LOOKAHEAD_LINES} lines after it are read with them (a token the library decides
 * by reading ahead, a raw string or a heredoc, is whole in the window or not closed at).
 * A window that cannot close grows (doubling) until it does or reaches {@link OPEN_LIMIT},
 * after which the rest is not coloured. The last lines of what is read stay open, so that a
 * block being written is read again from a few lines up, not from the top.
 *
 * `from` is a read already done: its lines before `start` are kept and the rest is read again.
 */
function readWindows(id: GrammarId, source: readonly string[], from: Read): Read | undefined {
	const runs = from.runs
	let start = from.start
	const n = source.length
	if (from.stopped) return from
	if (start >= n) return { runs, start, atRest: true, stopped: false }
	for (;;) {
		let end = start + 1
		for (
			let chars = (source[start] as string).length;
			end < n && end < start + WINDOW_LINES;
			end++
		) {
			chars += (source[end] as string).length + 1
			if (chars > WINDOW_CHARS) break
		}
		for (;;) {
			const reachesEnd = end >= n
			const full = highlightOnce(
				id,
				source.slice(start, Math.min(n, end + LOOKAHEAD_LINES)).join('\n'),
			)
			if (!full) return undefined
			const cut = reachesEnd ? Math.max(start, n - LOOKAHEAD_LINES) : end
			if (cut > start) {
				const head = highlightOnce(id, source.slice(start, cut).join('\n'))
				if (!head) return undefined
				if (head.atRest && sameLines(head.lines, full.lines, cut - start)) {
					runs.length = start
					runs.push(...head.lines)
					if (reachesEnd) {
						runs.push(...full.lines.slice(cut - start))
						return { runs, start: cut, atRest: full.atRest, stopped: false }
					}
					start = cut
					break
				}
			}
			const length = source.slice(start, end).join('\n').length
			if (length > OPEN_LIMIT) {
				runs.length = start
				return { runs, start, atRest: false, stopped: true }
			}
			if (reachesEnd) {
				runs.length = start
				runs.push(...full.lines)
				return { runs, start, atRest: full.atRest, stopped: false }
			}
			// Grow the window, doubling, but not past the open limit by more than a line.
			let grown = Math.min(n, end + Math.max(WINDOW_LINES, end - start))
			while (grown > end + 1 && source.slice(start, grown).join('\n').length > OPEN_LIMIT) {
				grown = end + Math.max(1, (grown - end) >> 1)
			}
			end = grown
		}
	}
}

/** The block as read last, kept so that a block being written is read from where it was cut, not from the top. */
interface Entry {
	readonly id: GrammarId
	/** The source lines before `read.start`: what `read.runs` was built on. */
	committed: string[]
	read: Read
}

const ENTRIES = 8
const recent: Entry[] = []
const FINISHED_CHARS = 500_000
const finished = new Map<string, Coloured>()
let finishedChars = 0

function entryFor(id: GrammarId, source: readonly string[]): Entry {
	for (let i = 0; i < recent.length; i++) {
		const entry = recent[i] as Entry
		if (entry.id !== id || entry.committed.length > source.length) continue
		let same = true
		for (let n = 0; n < entry.committed.length; n++) {
			if (entry.committed[n] !== source[n]) {
				same = false
				break
			}
		}
		if (!same) continue
		recent.splice(i, 1)
		recent.unshift(entry)
		return entry
	}
	const entry: Entry = {
		id,
		committed: [],
		read: { runs: [], start: 0, atRest: true, stopped: false },
	}
	recent.unshift(entry)
	if (recent.length > ENTRIES) recent.length = ENTRIES
	return entry
}

/** The `above` of the part that follows `source`, given how its read ended. */
function continuation(source: readonly string[], read: Read): string {
	if (read.stopped) return STOPPED
	if (read.atRest) return ''
	const open = source.slice(read.start).join('\n')
	return open.length > OPEN_LIMIT ? STOPPED : open
}

/**
 * The runs of the leading lines of a block, or `undefined` when it is drawn plain: the
 * language is not one that is ready, the setting or the terminal says no colour, or the
 * first line is already past a limit.
 *
 * `flow.above` is the open lines above `lines` that the library must read first (a
 * printed part of a block carries them); the runs returned are for `lines` only. A block
 * drawn whole, and the same block drawn a part at a time, give the same runs for a line
 * as long as no unclosed construct above it is longer than {@link OPEN_LIMIT}.
 *
 * The block is remembered: drawn again whole it costs a lookup, and a block that grows
 * (the one being written) is read again only from its last closed window.
 */
export function colourLines(
	word: string | undefined,
	lines: readonly string[],
	flow: CodeFlow = NO_FLOW,
): Coloured | undefined {
	if (!enabled || !colourWanted() || flow.above === STOPPED) return undefined
	const id = grammarOf(word)
	if (id === undefined || states.get(id)?.status !== 'ready' || !core) return undefined
	const count = colourableLines(lines, flow, word)
	if (count === 0) return undefined
	const body = count === lines.length ? lines : lines.slice(0, count)
	if (flow.above !== '') {
		const above = flow.above.split('\n')
		const source = [...above, ...body]
		const read = readWindows(id, source, { runs: [], start: 0, atRest: true, stopped: false })
		if (!read) return undefined
		return {
			lines: read.runs.slice(above.length, above.length + body.length),
			above: continuation(source, read),
		}
	}
	const key = `${id}\u0000${body.join('\n')}`
	const known = finished.get(key)
	if (known) {
		finished.delete(key)
		finished.set(key, known)
		return known
	}
	const entry = entryFor(id, body)
	const read = readWindows(id, body, entry.read)
	if (!read) return undefined
	entry.read = read
	entry.committed = body.slice(0, read.start)
	const result: Coloured = {
		lines: read.runs.slice(0, body.length),
		above: continuation(body, read),
	}
	remember(key, result)
	return result
}

/** Keep a read block under its text, up to {@link FINISHED_CHARS} of text; the oldest goes first. */
function remember(key: string, result: Coloured): void {
	if (key.length > FINISHED_CHARS / 4) return
	finished.set(key, result)
	finishedChars += key.length
	for (const old of finished.keys()) {
		if (finishedChars <= FINISHED_CHARS) break
		finished.delete(old)
		finishedChars -= old.length
	}
}

/**
 * What the part of a block that follows `lines` starts from. Called as a reply is cut
 * into printed parts, with the lines the part just printed holds.
 */
export function flowAfter(
	word: string | undefined,
	flow: CodeFlow,
	lines: readonly string[],
): CodeFlow {
	const chars = lines.reduce((n, line) => n + line.length + 1, 0)
	const base = { spent: flow.spent + chars, block: flow.block + chars }
	if (flow.above === STOPPED) return { above: STOPPED, ...base }
	if (grammarOf(word) === undefined) return { above: '', ...base }
	// A limit that ends the colouring inside these lines ends it for the rest of the block.
	if (colourableLines(lines, flow, word) < lines.length) return { above: STOPPED, ...base }
	return { above: colourLines(word, lines, flow)?.above ?? '', ...base }
}

/**
 * The runs of a line that a wrap cut into `pieces`: each piece's own characters in the
 * kinds the line gave them. A wrapper may drop the blanks it broke at, so each piece is
 * found in the line after the one before; a piece that cannot be found is `undefined`
 * (drawn plain) rather than guessed at.
 */
export function runsForPieces(
	line: string,
	runs: CodeLine,
	pieces: readonly string[],
): (CodeLine | undefined)[] {
	const kinds: (CodeKind | undefined)[] = []
	for (const run of runs) for (let i = 0; i < run.text.length; i++) kinds.push(run.kind)
	let pos = 0
	return pieces.map((piece) => {
		if (line === '') return []
		// A wrapper may have dropped the blanks it broke at.
		while (pos < line.length && line[pos] !== piece[0] && /\s/u.test(line[pos] as string)) {
			if (line[pos] === '\t' && piece[0] === ' ') break
			pos++
		}
		const out: CodeRun[] = []
		const add = (text: string, kind: CodeKind | undefined): void => {
			const last = out[out.length - 1]
			if (last && last.kind === kind)
				out[out.length - 1] = { text: last.text + text, ...(kind ? { kind } : {}) }
			else out.push(kind ? { text, kind } : { text })
		}
		let at = pos
		for (let i = 0; i < piece.length; ) {
			const want = piece[i] as string
			const have = line[at]
			if (have === want) {
				add(want, kinds[at])
				at++
				i++
			} else if (have === '\t' && want === ' ') {
				// The wrapper drew a tab as blanks (up to a tab stop of 8).
				let n = 0
				while (i < piece.length && piece[i] === ' ' && n < 8) {
					add(' ', kinds[at])
					i++
					n++
				}
				at++
			} else return undefined
		}
		pos = at
		return out
	})
}

/**
 * What a reply that is printed while it is written asks of the colouring (see
 * `CodeHooks` in `stream-flow.ts`): whether a language is ready, what a printed part
 * leaves for the next, and a nudge to start reading the grammars of fences that have
 * just been written.
 */
export const codeFlowHooks = {
	ready: (word: string | undefined): boolean => grammarState(word) !== 'loading',
	next: flowAfter,
	opened: (lines: string): void => {
		for (const word of languagesIn(lines)) grammarState(word)
	},
}

/**
 * The whole of `lines` read in one call of the library, with no window, no limit and no
 * memory: what a block would be given if it were never cut. For tests, which hold the
 * windowed and the part-by-part colouring to it.
 */
export function readInOneCall(
	word: string | undefined,
	lines: readonly string[],
): CodeLine[] | undefined {
	const id = grammarOf(word)
	if (id === undefined || states.get(id)?.status !== 'ready') return undefined
	return highlightOnce(id, lines.join('\n'))?.lines
}

/** Forget what has been read and loaded; for tests. */
export function resetCodeHighlightForTests(
	options: { loaders?: Partial<Record<GrammarId, () => Promise<Module>>>; waitMs?: number } = {},
): void {
	states.clear()
	roots.clear()
	recent.length = 0
	finished.clear()
	finishedChars = 0
	core = undefined
	corePromise = undefined
	enabled = true
	loaders = { ...LOADERS, ...options.loaders }
	waitMs = options.waitMs ?? GRAMMAR_WAIT_MS
	version++
}
