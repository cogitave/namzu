/**
 * The seam a language server arrives on.
 *
 * Declared in the SDK and implemented in `@namzu/lsp`, the same split
 * `Sandbox` uses: the kernel owns the shape a tool programs against, and the
 * optional package owns the process that answers. A host constructs one and
 * puts it on the tool context — there is no `registerProvider()` discovery
 * step, because a capability a host cannot see it wired up is one it cannot
 * debug either.
 *
 * Kept here rather than imported from `@namzu/lsp` because the dependency
 * direction forbids it: `sdk ← lsp`, never the other way. A duplicated
 * declaration would be a second definition that can drift, so `@namzu/lsp`
 * imports THESE types and implements them.
 */

/** A place in a file, zero-based, matching the language-server wire. */
export interface SourceLocation {
	/** Absolute path. Callers get back something they can open. */
	readonly path: string
	readonly line: number
	readonly character: number
	readonly endLine?: number
	readonly endCharacter?: number
}

/**
 * What a navigation query answers.
 *
 * Three cases, closed, and the last two are separate on purpose.
 * `unsupported` is "this server does not do that" — a caller can fall back
 * to `grep` and say the answer is textual. `failed` is "something broke" —
 * a caller must not present the absence of an answer as a complete one.
 *
 * Neither is `{ kind: 'locations', locations: [] }`. An empty list means "I
 * looked, and there are none", which is a real answer and the one a
 * deletion depends on; conflating it with a failure is how an agent
 * concludes a symbol has no callers because the server never started.
 */
export type CodeNavigationResult =
	| { readonly kind: 'locations'; readonly locations: readonly SourceLocation[] }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly error: string }

/** A symbol found by name rather than by position. */
export interface SymbolLocation extends SourceLocation {
	readonly name: string
	/** The wire's own symbol-kind number, when the server gave one. */
	readonly symbolKind?: number
	/** The class, module or namespace it sits in, when the server gave one. */
	readonly containerName?: string
}

/**
 * What hovering over a position says.
 *
 * `contents` may be EMPTY, and that is a real answer: hovering over
 * whitespace or a comment resolves to nothing, and a caller must be able to
 * tell that from a server that failed. Same reason `locations: []` is not a
 * failure.
 */
export type HoverResult =
	| { readonly kind: 'hover'; readonly contents: string }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly error: string }

export type SymbolSearchResult =
	| { readonly kind: 'symbols'; readonly symbols: readonly SymbolLocation[] }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly error: string }

export interface CodeNavigationProvider {
	/** Where the symbol under this position is declared. */
	definition(file: string, line: number, character: number): Promise<CodeNavigationResult>
	/** Everywhere the symbol under this position is used. */
	references(file: string, line: number, character: number): Promise<CodeNavigationResult>
	/** The symbol's type and documentation, without opening the file. */
	hover(file: string, line: number, character: number): Promise<HoverResult>
	/**
	 * Find a declaration by NAME, with no position.
	 *
	 * The operation an agent reaches for first, and the one whose absence
	 * made the rest unreachable: `definition` and `references` both need a
	 * line and a character, and an agent starting from a name has neither.
	 * Without this, every navigation began with a grep — which is the text
	 * path this package exists to replace.
	 *
	 * `scope` is a file path or an extension that picks which language's
	 * server answers. Absent means every configured language.
	 */
	symbols(query: string, scope?: string): Promise<SymbolSearchResult>
	/**
	 * Stop whatever backs it.
	 *
	 * Not optional. An implementation spawns a process, and a provider that
	 * could not be told to stop leaves one behind per run.
	 */
	dispose(): Promise<void>
}
