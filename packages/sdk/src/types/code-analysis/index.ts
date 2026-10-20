/**
 * The seam a semantic code index arrives on.
 *
 * Declared in the SDK and implemented in `@namzu/analysis`, the same split
 * `CodeNavigationProvider` uses with `@namzu/lsp`: the kernel owns the shape a
 * tool programs against, the optional package owns the parser and the store
 * that answer. A host constructs one and puts it on the tool context — there
 * is no discovery step.
 *
 * Kept here rather than imported from `@namzu/analysis` because the
 * dependency direction forbids it: `sdk ← analysis`, never the other way.
 *
 * ## What this answers that `grep` and a language server do not
 *
 * `grep` finds a string and says nothing of the function around it. A
 * language server resolves a symbol the project's own types can see, and has
 * nothing to say about a 40 MB bundle with no types and a hundred
 * single-letter names. This index is for the second case: *which function
 * contains this literal, what is its exact source, and who calls it by name*,
 * over code nobody wrote for you to read.
 *
 * ## Positions
 *
 * Lines and columns are ONE-based, and columns count UTF-16 code units, which
 * is what a JavaScript string index is. A character outside the Basic
 * Multilingual Plane therefore takes two columns. `start` / `end` are the
 * same UTF-16 offsets into the file's text, half-open. A line ends at `\n`.
 */

/**
 * How much of the question the answer covers.
 *
 * Two cases, and the second carries its reasons. `partial` is not a failure —
 * the answer is true as far as it goes — but a caller deciding "nothing
 * calls this" from a partial answer is guessing, and the reasons say what is
 * missing (a file that did not parse, a file that changed since it was
 * indexed, a page cut off by `limit`).
 */
export type AnalysisCoverage =
	| { readonly status: 'complete' }
	| { readonly status: 'partial'; readonly reasons: readonly string[] }

/**
 * The evidence behind an answer, in three parts.
 *
 * - `observed`: what the index read out of the files, stated as fact.
 * - `inferred`: what was concluded rather than read. A callee matched by
 *   its TEXT is an inference — the index does no scope analysis, so two
 *   unrelated functions called `run` are the same callee to it.
 * - `coverage`: whether the answer is the whole answer.
 *
 * Every successful result carries one. An answer without it reads as
 * certain, and the cases this package exists for are the ones where it is
 * not.
 */
export interface AnalysisEvidence {
	readonly observed: readonly string[]
	readonly inferred: readonly string[]
	readonly coverage: AnalysisCoverage
}

/**
 * What a query answers. Three cases, closed, as with `CodeNavigationResult`:
 * `unsupported` is "this index does not do that", `failed` is "something
 * broke", and neither is an empty page. An empty page means "I looked and
 * there are none", the answer a deletion depends on.
 */
export type CodeAnalysisResult<T> =
	| { readonly kind: 'ok'; readonly value: T; readonly evidence: AnalysisEvidence }
	| { readonly kind: 'unsupported'; readonly reason: string }
	| { readonly kind: 'failed'; readonly error: string }

/**
 * One page of a larger answer. `total` is the count across ALL pages, so a
 * caller can tell a complete list from the first slice of a long one;
 * `nextCursor` is absent on the last page and is opaque — pass it back
 * unchanged.
 */
export interface AnalysisPage<T> {
	readonly items: readonly T[]
	readonly total: number
	readonly nextCursor?: string
}

/** The paging arguments every list-returning request takes. */
export interface AnalysisPaging {
	/** Items per page. The provider clamps it to its own maximum. */
	readonly limit?: number
	/** The previous page's `nextCursor`. */
	readonly cursor?: string
}

export type AnalysisFunctionKind =
	| 'declaration'
	| 'expression'
	| 'arrow'
	| 'method'
	| 'getter'
	| 'setter'
	| 'constructor'

/**
 * A function, located. `id` is valid until its file changes and is then
 * re-issued: do not keep one across an `index` that re-read the file.
 */
export interface AnalysisFunction {
	readonly id: number
	/** `null` for an anonymous function with nothing to infer a name from. */
	readonly name: string | null
	readonly kind: AnalysisFunctionKind
	/** Absolute path. */
	readonly path: string
	readonly line: number
	readonly column: number
	readonly endLine: number
	readonly start: number
	readonly end: number
}

/** A piece of a file's source, with the honesty about a cut. */
export interface AnalysisSourceSlice {
	readonly text: string
	/** The full length in UTF-16 units, whether or not all of it is in `text`. */
	readonly chars: number
	/** `true` when `text` is shorter than `chars` because of the size cap. */
	readonly truncated: boolean
}

export interface IndexRequest {
	/** Absolute directory to index. */
	readonly root: string
	/** Re-read every file, ignoring size / mtime / hash. */
	readonly force?: boolean
}

export interface IndexSummary {
	readonly root: string
	/** Whether the index lives on disk; `false` for an in-memory fallback. */
	readonly persisted: boolean
	readonly files: {
		readonly indexed: number
		/** Parsed this call (new or changed). */
		readonly parsed: number
		/** Seen and left alone: same size and mtime, or same content hash. */
		readonly unchanged: number
		readonly removed: number
		readonly skipped: number
		readonly withParseErrors: number
	}
	/** Why files were skipped, as reason → count. */
	readonly skippedReasons: Readonly<Record<string, number>>
	readonly functions: number
	readonly strings: number
	readonly calls: number
	readonly durationMs: number
}

export interface FindLiteralRequest extends AnalysisPaging {
	readonly root: string
	/** The substring to look for inside string and template literals. */
	readonly text: string
	/** Absolute file or directory to restrict the search to. */
	readonly path?: string
	/** Default `true`. */
	readonly caseSensitive?: boolean
}

export interface AnalysisLiteralHit {
	readonly path: string
	readonly line: number
	readonly column: number
	readonly start: number
	readonly end: number
	readonly kind: 'string' | 'template' | 'key'
	/** The literal's value, cut to a preview. */
	readonly value: string
	readonly valueTruncated: boolean
	/** The innermost function around it; absent at the top level of a file. */
	readonly function?: AnalysisFunction
}

export interface EnclosingFunctionRequest {
	readonly root: string
	readonly path: string
	readonly line: number
	readonly column?: number
	/** Cap on the source slice, in UTF-16 units. */
	readonly maxChars?: number
}

export interface AnalysisEnclosingFunction {
	/** `null` when the position is not inside any function — a real answer. */
	readonly function: AnalysisFunction | null
	/** The function's parents, innermost first. */
	readonly parents: readonly AnalysisFunction[]
	readonly source?: AnalysisSourceSlice
}

export interface FunctionSourceRequest extends AnalysisPaging {
	readonly root: string
	/** A function id from an earlier answer. */
	readonly id?: number
	/** Alternatively, a file and a name; several functions can share one. */
	readonly path?: string
	readonly name?: string
	readonly maxChars?: number
}

export interface AnalysisFunctionSource {
	readonly function: AnalysisFunction
	readonly parents: readonly AnalysisFunction[]
	readonly source: AnalysisSourceSlice
}

export interface CallersOfRequest extends AnalysisPaging {
	readonly root: string
	/** The callee text: `foo`, `obj.foo`, `this.foo`. */
	readonly name: string
	/**
	 * `file` looks in `path` only and is the default, because a callee matched
	 * by text is far more likely to be the one you mean inside one file than
	 * across a bundle of unrelated modules that reuse short names.
	 */
	readonly scope?: 'file' | 'workspace'
	readonly path?: string
	/**
	 * `exact` matches the callee text as written. `member` also matches any
	 * `<expression>.name`, which finds method calls whose receiver is unknown.
	 */
	readonly match?: 'exact' | 'member'
}

export interface AnalysisCallSite {
	readonly path: string
	readonly line: number
	readonly column: number
	readonly callee: string
	readonly kind: 'call' | 'new'
	readonly argumentCount: number
	/** The function the call sits in; absent at the top level of a file. */
	readonly caller?: AnalysisFunction
}

export interface ImportsRequest extends AnalysisPaging {
	readonly root: string
	readonly path: string
}

export type AnalysisModuleEdge =
	| {
			readonly direction: 'import'
			readonly kind: 'static' | 'type' | 'require' | 'dynamic'
			readonly source: string
			readonly names: readonly string[]
			readonly line: number
			readonly column: number
	  }
	| {
			readonly direction: 'export'
			readonly kind: 'named' | 'default' | 'reexport' | 'star'
			readonly name: string
			readonly source?: string
			readonly line: number
			readonly column: number
	  }

export interface CodeAnalysisProvider {
	/**
	 * Build or refresh the index for a directory. Incremental: a file whose
	 * size and mtime are unchanged is not read, and one whose content hash is
	 * unchanged is not parsed.
	 */
	index(request: IndexRequest): Promise<CodeAnalysisResult<IndexSummary>>
	/** Where a string appears, and the function around each hit. */
	findLiteral(
		request: FindLiteralRequest,
	): Promise<CodeAnalysisResult<AnalysisPage<AnalysisLiteralHit>>>
	/** The function containing a position, with its source and parent chain. */
	enclosingFunction(
		request: EnclosingFunctionRequest,
	): Promise<CodeAnalysisResult<AnalysisEnclosingFunction>>
	/** A function's exact source, by id or by file and name. */
	functionSource(
		request: FunctionSourceRequest,
	): Promise<CodeAnalysisResult<AnalysisPage<AnalysisFunctionSource>>>
	/** Call sites of a name. Matched by text, not by scope; see the evidence. */
	callersOf(request: CallersOfRequest): Promise<CodeAnalysisResult<AnalysisPage<AnalysisCallSite>>>
	/** One file's imports and exports. */
	imports(request: ImportsRequest): Promise<CodeAnalysisResult<AnalysisPage<AnalysisModuleEdge>>>
	/** Close whatever backs it. Not optional: an open database is a held file. */
	dispose(): Promise<void>
}
