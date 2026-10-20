import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'

import type {
	AnalysisEvidence,
	AnalysisFunction,
	AnalysisModuleEdge,
	AnalysisPage,
	AnalysisSourceSlice,
	CodeAnalysisProvider,
	CodeAnalysisResult,
} from '../../types/code-analysis/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { isWithin, resolveWithinAnyReal, toolRoots } from '../paths.js'

/**
 * Cited lookups over a semantic index of JavaScript and TypeScript.
 *
 * For the question `grep` answers with a line and nothing around it: *this
 * string is in the code — which function is it in, what is that function's
 * whole source, and what calls it?* It is built for code nobody wrote for you
 * to read (a minified bundle, a vendored build), where the function has no
 * useful name and the line is 40,000 characters wide.
 *
 * **Not in `getBuiltinTools()`, and not registered when no provider is
 * configured**, for the reason `lsp` is not: a tool that is always present
 * and always answers "unavailable" costs a decision on every turn to say
 * nothing. See `tools/builtins/lsp.ts`.
 *
 * ## One path argument, one boundary
 *
 * Every operation takes `path`, declared as this tool's `pathArgument`, and
 * resolves it with `resolveWithinAnyReal` over `toolRoots` — the resolver and
 * the review route `read` and `grep` use. A path outside the roots is
 * reviewed before the call runs when the host reviews such paths, and refused
 * with the same message otherwise. There is no second way past the boundary:
 * the index is built from files under a directory THIS tool has just
 * resolved, never from a path the model supplied to the provider directly.
 */

/** Items per page when the call names none. */
const DEFAULT_LIMIT = 50
/** The most a page may hold, whatever the call asks for. */
const MAX_LIMIT = 200
/** Source characters shown when the call names no cap. */
const DEFAULT_MAX_CHARS = 20_000
const MAX_MAX_CHARS = 200_000

const paging = {
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.optional()
		.describe(`Results per page (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`),
	cursor: z.string().optional().describe('`next cursor` from the previous page, unchanged.'),
}

const maxChars = z
	.number()
	.int()
	.min(200)
	.max(MAX_MAX_CHARS)
	.optional()
	.describe(`Cap on source shown (default ${DEFAULT_MAX_CHARS}); a cut is reported.`)

// Descriptions are short on purpose: this schema is sent with every request,
// and the first draft of it cost four times what `grep`'s does.
const indexOp = z.object({
	operation: z
		.literal('index')
		.describe('Build or refresh the index (incremental). Other operations build it on first use.'),
	path: z.string().optional().describe('A session directory; defaults to the working directory.'),
	force: z.boolean().optional().describe('Re-read every file.'),
})

const findLiteralOp = z.object({
	operation: z
		.literal('find_literal')
		.describe('Find string/template literals containing `text`, each with its enclosing function.'),
	text: z.string().min(1),
	path: z
		.string()
		.optional()
		.describe('File or directory to search; defaults to the working directory.'),
	case_sensitive: z.boolean().optional().describe('Default true.'),
	...paging,
})

const enclosingOp = z.object({
	operation: z
		.literal('enclosing_function')
		.describe('The function containing a position: exact source, line range, parent chain.'),
	path: z.string(),
	line: z.number().int().min(1).describe('1-based.'),
	column: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('1-based UTF-16 column (default 1); needed on minified lines.'),
	max_chars: maxChars,
})

const functionSourceOp = z.object({
	operation: z
		.literal('function_source')
		.describe(
			"A function's exact source, by `function_id` from a result, or by `path` and `name`.",
		),
	function_id: z.number().int().min(0).optional(),
	path: z.string().optional(),
	name: z.string().min(1).optional(),
	max_chars: maxChars,
	...paging,
})

const callersOp = z.object({
	operation: z
		.literal('callers_of')
		.describe(
			'Call sites of a callee TEXT (not scope-aware), each with its caller. Per file by default.',
		),
	name: z.string().min(1).describe('Callee text: `foo`, `obj.foo`, `this.foo`.'),
	scope: z
		.enum(['file', 'workspace'])
		.optional()
		.describe('`file` (default) needs `path`; `workspace` mixes same-named functions.'),
	path: z.string().optional(),
	match: z.enum(['exact', 'member']).optional().describe('`member` also matches `<expr>.name`.'),
	...paging,
})

const importsOp = z.object({
	operation: z.literal('imports').describe("One file's imports and exports."),
	path: z.string(),
	...paging,
})

const inputSchema = z.discriminatedUnion('operation', [
	indexOp,
	findLiteralOp,
	enclosingOp,
	functionSourceOp,
	callersOp,
	importsOp,
])

type CodeAnalysisInput = z.infer<typeof inputSchema>

export const CODE_ANALYSIS_TOOL_NAME = 'code_analysis'

export const CodeAnalysisTool = defineTool({
	name: CODE_ANALYSIS_TOOL_NAME,
	description:
		"Find a string in JS/TS code and the function around it, read that function whole, list its callers or a file's imports. For minified or unfamiliar code where grep returns one huge line. Paged, cited as path:line:column, with observed/inferred/coverage evidence.",
	inputSchema,
	category: 'filesystem',
	// Declared so a path outside the turn's roots can be reviewed before the
	// call runs, rather than refused after. See `ToolDefinition.pathArgument`.
	pathArgument: 'path',
	permissions: ['file_read'],
	// Reads source files and writes only its own cache, outside the roots.
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input: CodeAnalysisInput, context): Promise<ToolResult> {
		const provider = context.codeAnalysis
		if (!provider) {
			return fail(
				'This turn has no code analysis provider, so there is no index to query. A host supplies one on the tool context; `grep` is the fallback, and it answers a different question.',
			)
		}
		if (context.sandbox) {
			// The index reads the HOST file system. In a sandboxed turn the
			// workspace the model sees is not that one, and answering from the
			// host would cite files the turn cannot open.
			return fail(
				'This turn runs in a sandbox, and the code index reads the host file system, not the sandbox workspace. Use `grep` and `read` here.',
			)
		}

		const roots = toolRoots(context)
		let target: string
		try {
			// The SAME resolver `read` runs, so a path is on one side of the
			// boundary for both tools or for neither.
			target = await resolveWithinAnyReal(roots, input.path)
		} catch (err) {
			return fail(err instanceof Error ? err.message : String(err))
		}

		// `function_id` alone names no path; the root is then the working one.
		const owner = await owningRoot(roots, target)
		if (owner.kind === 'file') {
			return fail(
				`${target} was reached as a single file, not through a directory this turn may read, and the index is built over a directory. Ask the user to add its directory to the session.`,
			)
		}
		if (owner.kind === 'none') {
			return fail(`No readable directory of this turn contains ${target}.`)
		}
		const root = owner.root

		switch (input.operation) {
			case 'index': {
				const result = await provider.index({
					root,
					...(input.force ? { force: true } : {}),
				})
				return render(result, (value) => {
					const f = value.files
					const lines = [
						`Indexed ${value.root}: ${f.indexed} files (${f.parsed} parsed, ${f.unchanged} unchanged, ${f.removed} removed, ${f.skipped} skipped, ${f.withParseErrors} with parse errors) in ${value.durationMs} ms.`,
						`${value.functions} functions, ${value.strings} string literals, ${value.calls} calls. ${value.persisted ? 'Cached on disk.' : 'Held in memory only; it is gone when this process exits.'}`,
					]
					const reasons = Object.entries(value.skippedReasons)
					if (reasons.length > 0) {
						lines.push(`Skipped: ${reasons.map(([why, n]) => `${n} ${why}`).join(', ')}.`)
					}
					return lines
				})
			}
			case 'find_literal': {
				const result = await provider.findLiteral({
					root,
					text: input.text,
					path: target,
					...(input.case_sensitive === false ? { caseSensitive: false } : {}),
					...pageArgs(input),
				})
				return renderPage(result, (hit) => {
					const where = `${hit.path}:${hit.line}:${hit.column}`
					const shown = JSON.stringify(hit.value) + (hit.valueTruncated ? ' (cut)' : '')
					const inside = hit.function ? ` in ${describeFunction(hit.function)}` : ' at top level'
					return `${where}  ${hit.kind} ${shown}${inside}`
				})
			}
			case 'enclosing_function': {
				const result = await provider.enclosingFunction({
					root,
					path: target,
					line: input.line,
					...(input.column !== undefined ? { column: input.column } : {}),
					maxChars: input.max_chars ?? DEFAULT_MAX_CHARS,
				})
				return render(result, (value) => {
					if (!value.function) {
						return [`${target}:${input.line}:${input.column ?? 1} is not inside any function.`]
					}
					const lines = [`${describeFunction(value.function)}`]
					if (value.parents.length > 0) {
						lines.push(`parents: ${value.parents.map(describeFunction).join(' < ')}`)
					}
					if (value.source) lines.push(...sourceLines(value.source))
					return lines
				})
			}
			case 'function_source': {
				if (input.function_id === undefined && !(input.path !== undefined && input.name)) {
					return fail('function_source needs `function_id`, or `path` together with `name`.')
				}
				const result = await provider.functionSource({
					root,
					...(input.function_id !== undefined ? { id: input.function_id } : {}),
					...(input.name ? { name: input.name, path: target } : {}),
					maxChars: input.max_chars ?? DEFAULT_MAX_CHARS,
					...pageArgs(input),
				})
				return renderPage(result, (item) =>
					[
						describeFunction(item.function),
						item.parents.length > 0
							? `parents: ${item.parents.map(describeFunction).join(' < ')}`
							: undefined,
						...sourceLines(item.source),
					]
						.filter((l): l is string => l !== undefined)
						.join('\n'),
				)
			}
			case 'callers_of': {
				const scope = input.scope ?? 'file'
				if (scope === 'file' && input.path === undefined) {
					return fail(
						'callers_of looks in one file by default, so it needs `path`. Pass `scope: "workspace"` to search the whole index; it matches by name only and will mix unrelated functions that share one.',
					)
				}
				const result = await provider.callersOf({
					root,
					name: input.name,
					scope,
					...(input.path !== undefined ? { path: target } : {}),
					...(input.match ? { match: input.match } : {}),
					...pageArgs(input),
				})
				return renderPage(result, (site) => {
					const inside = site.caller ? ` in ${describeFunction(site.caller)}` : ' at top level'
					return `${site.path}:${site.line}:${site.column}  ${site.kind === 'new' ? 'new ' : ''}${site.callee}(${site.argumentCount} arg${site.argumentCount === 1 ? '' : 's'})${inside}`
				})
			}
			case 'imports': {
				const result = await provider.imports({ root, path: target, ...pageArgs(input) })
				return renderPage(result, (edge) => describeEdge(edge, target))
			}
		}
	},
})

function fail(error: string): ToolResult {
	return { success: false, output: '', error }
}

function pageArgs(input: { limit?: number | undefined; cursor?: string | undefined }): {
	limit: number
	cursor?: string
} {
	return {
		limit: input.limit ?? DEFAULT_LIMIT,
		...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
	}
}

type OwningRoot =
	| { readonly kind: 'dir'; readonly root: string }
	| { readonly kind: 'file' }
	| { readonly kind: 'none' }

/**
 * The directory of this turn that contains `target`, canonicalised.
 *
 * Roots are directories except when an approval named a single file: that
 * file is a root for ONE call, and indexing its parent would read what the
 * approval never covered. So a file reached only that way is refused rather
 * than widened.
 */
async function owningRoot(roots: readonly string[], target: string): Promise<OwningRoot> {
	let sawFile = false
	for (const candidate of roots) {
		let real: string
		try {
			real = await realpath(candidate)
			if (!(await stat(real)).isDirectory()) {
				if (isWithin(real, target) || real === target) sawFile = true
				continue
			}
		} catch {
			continue
		}
		if (isWithin(real, target)) return { kind: 'dir', root: real }
	}
	return sawFile ? { kind: 'file' } : { kind: 'none' }
}

function describeFunction(fn: AnalysisFunction): string {
	const lines = fn.endLine === fn.line ? `line ${fn.line}` : `lines ${fn.line}-${fn.endLine}`
	return `${fn.name ?? '(anonymous)'} [${fn.kind}, id ${fn.id}] ${fn.path}:${fn.line}:${fn.column} (${lines})`
}

function describeEdge(edge: AnalysisModuleEdge, path: string): string {
	const where = `${path}:${edge.line}:${edge.column}`
	if (edge.direction === 'import') {
		const names = edge.names.length > 0 ? ` { ${edge.names.join(', ')} }` : ''
		return `${where}  import (${edge.kind})${names} from ${JSON.stringify(edge.source)}`
	}
	const from = edge.source !== undefined ? ` from ${JSON.stringify(edge.source)}` : ''
	return `${where}  export (${edge.kind}) ${edge.name}${from}`
}

function sourceLines(slice: AnalysisSourceSlice): string[] {
	const lines = ['--- source ---', slice.text]
	if (slice.truncated) {
		lines.push(
			`--- cut: showing ${slice.text.length} of ${slice.chars} characters; raise max_chars to see more ---`,
		)
	}
	return lines
}

function evidenceLines(evidence: AnalysisEvidence): string[] {
	const lines: string[] = []
	if (evidence.observed.length > 0) lines.push(`observed: ${evidence.observed.join('; ')}`)
	if (evidence.inferred.length > 0) lines.push(`inferred: ${evidence.inferred.join('; ')}`)
	lines.push(
		evidence.coverage.status === 'complete'
			? 'coverage: complete'
			: `coverage: partial - ${evidence.coverage.reasons.join('; ')}`,
	)
	return lines
}

function render<T>(
	result: CodeAnalysisResult<T>,
	body: (value: T) => string[],
	data?: (value: T) => unknown,
): ToolResult {
	switch (result.kind) {
		case 'ok':
			return {
				success: true,
				output: [...body(result.value), ...evidenceLines(result.evidence)].join('\n'),
				data: {
					value: data ? data(result.value) : result.value,
					evidence: result.evidence,
				},
			}
		case 'unsupported':
			// Distinct from a failure so the model can fall back and know why.
			return fail(
				`${result.reason} Fall back to \`grep\`, and treat the result as textual rather than resolved.`,
			)
		case 'failed':
			// NOT an empty result. An agent told a name has no callers deletes it.
			return fail(
				`Code analysis failed, so this answer is unknown rather than empty: ${result.error}`,
			)
	}
}

function renderPage<T>(
	result: CodeAnalysisResult<AnalysisPage<T>>,
	line: (item: T) => string,
): ToolResult {
	return render(
		result,
		(page) => {
			if (page.items.length === 0) {
				return [page.total === 0 ? 'No results.' : 'No results on this page.']
			}
			const lines = page.items.map(line)
			lines.push(
				page.nextCursor !== undefined
					? `-- ${page.items.length} of ${page.total} shown. next cursor: ${page.nextCursor}`
					: `-- ${page.items.length} of ${page.total} shown. last page.`,
			)
			return lines
		},
		(page) => ({
			total: page.total,
			count: page.items.length,
			items: page.items,
			...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
		}),
	)
}

/**
 * The tool, only when there is something for it to call.
 *
 * A function rather than a constant because the decision is per turn: the
 * same process can serve one session with an index and one without.
 */
export function getCodeAnalysisTools(
	provider: CodeAnalysisProvider | undefined,
): (typeof CodeAnalysisTool)[] {
	return provider ? [CodeAnalysisTool] : []
}
