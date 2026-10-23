import { z } from 'zod'

import type { NativeAnalysisProvider, NativeSymbolsParams } from '../../types/native-analysis/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'

/**
 * Read-only lookups over a native binary, answered by a Rust sidecar the
 * host holds: ELF, PE and Mach-O info, symbols, imports, exports and
 * strings. For the file `read` refuses to render: a compiled executable,
 * with or without JavaScript appended (a Bun `--compile` build, a Node
 * single executable, an Electron binary).
 *
 * **Not in `getBuiltinTools()`, and registered only when a host supplies a
 * provider**, for the reason `code_analysis` is not: a tool that is always
 * present and always answers "unavailable" costs a decision on every turn
 * to say nothing. The provider rides on the turn:
 * `QueryParams.nativeAnalysis` becomes `ToolContext.nativeAnalysis`.
 *
 * The sidecar never executes or links the target; every op is a read.
 */

// Descriptions are short on purpose: this schema is sent with every request.
const paging = {
	offset: z.number().int().min(0).optional().describe('Skip this many matches.'),
	limit: z.number().int().min(1).max(200).optional().describe('Most items to return.'),
}

const target = {
	path: z.string().describe('The file to read: an executable, shared library or archive.'),
	slice: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('For a universal (fat) Mach-O: which slice, default 0.'),
}

const infoOp = z.object({
	operation: z
		.literal('info')
		.describe(
			'Format, architecture, kind, sections, and embedded JavaScript payloads (Bun or Node SEA), with file offsets for `read`.',
		),
	...target,
})

const symbolsOp = z.object({
	operation: z
		.literal('symbols')
		.describe('Symbols: static or dynamic, demangled, filtered by name text, paged.'),
	which: z.enum(['all', 'static', 'dynamic']).optional().describe('Default `all`.'),
	contains: z.string().min(1).optional().describe('Keep names containing this text.'),
	kind: z.enum(['function', 'data', 'tls', 'other']).optional(),
	defined_only: z.boolean().optional().describe('Drop undefined (imported) symbols.'),
	demangle: z.boolean().optional().describe('Default true.'),
	...target,
	...paging,
})

const importsOp = z.object({
	operation: z
		.literal('imports')
		.describe('Import libraries (DT_NEEDED, PE import tables, Mach-O dylibs) and imported symbols.'),
	contains: z.string().min(1).optional(),
	library: z.string().min(1).optional().describe('Keep only imports from this library.'),
	...target,
	...paging,
})

const exportsOp = z.object({
	operation: z.literal('exports').describe('Exported symbols, with forwarding targets.'),
	contains: z.string().min(1).optional(),
	...target,
	...paging,
})

const stringsOp = z.object({
	operation: z
		.literal('strings')
		.describe('Printable runs over the file, in offset order; how a prompt or URL is found in a binary.'),
	contains: z.string().min(1).optional().describe('Keep strings containing this text.'),
	min_length: z.number().int().min(2).max(4096).optional().describe('Default 4.'),
	section: z.string().min(1).optional().describe('Keep only strings inside this section.'),
	max_string_length: z.number().int().min(16).max(16384).optional().describe('Default 1024.'),
	cursor: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('File offset to continue from: the previous page\'s `nextCursor`.'),
	...target,
	limit: paging.limit,
})

const inputSchema = z.discriminatedUnion('operation', [
	infoOp,
	symbolsOp,
	importsOp,
	exportsOp,
	stringsOp,
])

type NativeAnalysisInput = z.infer<typeof inputSchema>

const DEFAULT_LIMIT = 50

/** One line per symbol, or per string, is all the model needs. */
function pageLine(
	result: { truncated: boolean; nextOffset: number | null },
	shown: number,
	total: number,
): string {
	if (result.truncated && result.nextOffset !== null) {
		return `-- ${shown} shown of at least ${total}. next offset: ${result.nextOffset}`
	}
	if (total > shown) {
		return `-- ${shown} shown of ${total}`
	}
	return `-- ${shown} of ${total}. last page.`
}

export const NATIVE_ANALYSIS_TOOL_NAME = 'binary_analysis'

export const NativeAnalysisTool = defineTool({
	name: NATIVE_ANALYSIS_TOOL_NAME,
	// The first sentence is the discovery hint a deferred listing shows (about
	// 100 characters), so it carries the two reasons to reach for this tool.
	description:
		'Read a compiled binary — ELF, PE or Mach-O: format, sections, symbols, imports, strings, and the Bun or Node SEA JavaScript inside it. Never executes the target.',
	inputSchema,
	category: 'filesystem',
	// Declared so a path outside the turn's roots can be reviewed before the
	// call runs, rather than refused after. See `ToolDefinition.pathArgument`.
	pathArgument: 'path',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input: NativeAnalysisInput, context): Promise<ToolResult> {
		const provider = context.nativeAnalysis
		if (!provider) {
			return fail(
				'This turn has no native analysis provider. A host supplies one on the tool context.',
			)
		}
		if (context.sandbox) {
			// The sidecar reads the HOST file system. In a sandboxed turn the
			// workspace the model sees is not that one, and answering from the
			// host would cite files the turn cannot open.
			return fail(
				'This turn runs in a sandbox, and binary analysis reads the host file system, not the sandbox workspace.',
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

		const common = { path: target, ...(input.slice !== undefined ? { slice: input.slice } : {}) } as const
		try {
			switch (input.operation) {
				case 'info': {
					const info = await provider.binaryInfo(common)
					return ok(describeInfo(target, info), info)
				}
				case 'symbols': {
					const params: NativeSymbolsParams = {
						...common,
						...(input.which !== undefined ? { which: input.which } : {}),
						...(input.contains !== undefined ? { contains: input.contains } : {}),
						...(input.kind !== undefined ? { kind: input.kind } : {}),
						...(input.defined_only !== undefined ? { definedOnly: input.defined_only } : {}),
						...(input.demangle !== undefined ? { demangle: input.demangle } : {}),
						offset: input.offset ?? 0,
						limit: input.limit ?? DEFAULT_LIMIT,
					}
					const result = await provider.symbols(params)
					const lines: string[] = []
					for (const s of result.symbols) {
						const size = s.size > 0 ? ` size ${s.size}` : ''
						const from = s.source === 'dynamic' ? ' dyn' : ''
						const undef = s.undefined ? ' undefined' : ''
						lines.push(`${s.name}${size}${from}${undef} @ 0x${s.address.toString(16)}${s.section ? ` (${s.section})` : ''}`)
					}
					lines.push(pageLine(result, result.symbols.length, result.total))
					return ok(lines, result)
				}
				case 'imports': {
					const result = await provider.imports({
						...common,
						...(input.contains !== undefined ? { contains: input.contains } : {}),
						...(input.library !== undefined ? { library: input.library } : {}),
						offset: input.offset ?? 0,
						limit: input.limit ?? DEFAULT_LIMIT,
					})
					const lines: string[] = []
					for (const lib of result.libraries) {
						lines.push(`library ${lib.name} (${lib.kind})`)
					}
					for (const imp of result.imports) {
						const from = imp.library !== null ? ` from ${imp.library}` : ''
						const ord = imp.ordinal !== null ? `#${imp.ordinal}` : ''
						const weak = imp.weak ? ' weak' : ''
						lines.push(`${imp.name}${ord}${weak}${from}`)
					}
					lines.push(pageLine(result, result.imports.length, result.total))
					return ok(lines, result)
				}
				case 'exports': {
					const result = await provider.exports({
						...common,
						...(input.contains !== undefined ? { contains: input.contains } : {}),
						offset: input.offset ?? 0,
						limit: input.limit ?? DEFAULT_LIMIT,
					})
					const lines: string[] = []
					for (const e of result.exports) {
						const where =
							e.forwardedTo !== null
								? ` forwarded to ${e.forwardedTo}`
								: e.address !== null
									? ` @ 0x${e.address.toString(16)}`
									: ''
						const ord = e.ordinal !== null ? `#${e.ordinal}` : ''
						const weak = e.weak ? ' weak' : ''
						lines.push(`${e.name}${ord}${weak}${where}`)
					}
					lines.push(pageLine(result, result.exports.length, result.total))
					return ok(lines, result)
				}
				case 'strings': {
					const result = await provider.strings({
						...common,
						...(input.contains !== undefined ? { contains: input.contains } : {}),
						...(input.min_length !== undefined ? { minLength: input.min_length } : {}),
						...(input.section !== undefined ? { section: input.section } : {}),
						...(input.max_string_length !== undefined
							? { maxStringLength: input.max_string_length }
							: {}),
						...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
						limit: input.limit ?? DEFAULT_LIMIT,
					})
					const lines: string[] = []
					for (const s of result.strings) {
						const cut = s.truncated ? '…' : ''
						const enc = s.encoding === 'utf16le' ? ' [utf16le]' : ''
						lines.push(`0x${s.fileOffset.toString(16)}  ${JSON.stringify(s.text)}${cut}${enc}`)
					}
					// `total` is unknown until a complete scan from the start; an
					// honest page says so rather than inventing a count.
					if (result.total === null) {
						lines.push(
							result.nextCursor !== null
								? `-- ${result.strings.length} shown; more remain. next cursor: ${result.nextCursor}`
								: `-- ${result.strings.length} shown; scan complete.`,
						)
					} else {
						lines.push(
							result.nextCursor !== null
								? `-- ${result.strings.length} shown of at least ${result.total}. next cursor: ${result.nextCursor}`
								: `-- ${result.strings.length} of ${result.total}. scan complete.`,
						)
					}
					return ok(lines, result)
				}
			}
		} catch (err) {
			// A sidecar error (unknown format, too large, deadline) is a real
			// failure the model may retry differently, not an empty result.
			return fail(err instanceof Error ? err.message : String(err))
		}
	},
})

function describeInfo(path: string, info: Awaited<ReturnType<NativeAnalysisProvider['binaryInfo']>>): string[] {
	const lines: string[] = []
	const bits = info.bits !== undefined ? ` ${info.bits}-bit` : ''
	const arch = info.arch !== undefined ? ` ${info.arch}${bits}` : ''
	lines.push(
		`${path}: ${info.format}${info.kind !== undefined ? ` ${info.kind}` : ''}${arch}, ${info.size} bytes${info.stripped ? ', stripped' : ''}`,
	)
	if (info.note !== undefined) lines.push(`note: ${info.note}`)
	if (info.buildId !== undefined) lines.push(`build id: ${info.buildId}`)
	if (info.machoUuid !== undefined) lines.push(`uuid: ${info.machoUuid}`)
	if (info.pdb !== undefined) {
		lines.push(`pdb: ${info.pdb.path} (age ${info.pdb.age})`)
	}
	if (info.slices !== undefined && info.slices.length > 1) {
		lines.push(
			`fat binary, ${info.slices.length} slices: ${info.slices.map((s) => `${s.index}: ${s.arch}`).join(', ')}`,
		)
	}
	for (const section of info.sections ?? []) {
		lines.push(
			`section ${section.name}${section.segment !== null ? ` (${section.segment})` : ''} ${section.size} bytes @ 0x${(section.fileOffset ?? 0).toString(16)}`,
		)
	}
	for (const payload of info.embedded) {
		if (payload.kind === 'bun') {
			lines.push(
				payload.valid
					? `embedded Bun payload: ${payload.modules} modules (${payload.javascriptModules} JavaScript), layout ${payload.layout}, extractable`
					: `embedded Bun payload, not readable: ${payload.reason}`,
			)
		} else if (payload.kind === 'node-sea') {
			lines.push(
				`embedded Node SEA blob: ${payload.blobSize} bytes${payload.mainPath !== null ? `, main ${payload.mainPath}` : ''}, extractable`,
			)
		} else {
			lines.push(`embedded: ${payload.note}`)
		}
	}
	return lines
}

function ok(output: string[], data: unknown): ToolResult {
	// Sidecar responses can exceed a page; the data channel keeps the whole
	// shape for a caller that reads it, capped by the executor like any tool.
	return { success: true, output: output.join('\n'), data: { value: data } }
}

function fail(error: string): ToolResult {
	return { success: false, output: '', error }
}

/**
 * The tool, only when there is something for it to call.
 *
 * A function rather than a constant because the decision is per turn: the
 * same host can serve one session with a provider and one without.
 */
export function getNativeAnalysisTools(
	provider: NativeAnalysisProvider | undefined,
): (typeof NativeAnalysisTool)[] {
	return provider ? [NativeAnalysisTool] : []
}
