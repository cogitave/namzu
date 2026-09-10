import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type { SandboxWalkFilesOptions } from '../../types/sandbox/index.js'
import { subscribeToAbort } from '../../utils/abort.js'
import { defineTool } from '../defineTool.js'
import {
	resolveWithin,
	resolveWithinAny,
	resolveWithinAnyReal,
	resolveWithinReal,
	toolRoots,
} from '../paths.js'
import { relativePosix, resolveWithinPosix } from '../posix-path.js'

/** A remote read has no signal parameter; stop consuming it when the turn ends. */
async function readWithSignal(read: () => Promise<Buffer>, signal?: AbortSignal): Promise<Buffer> {
	signal?.throwIfAborted()
	if (!signal) return await read()
	let dispose: (() => void) | undefined
	try {
		const cancelled = new Promise<never>((_, reject) => {
			dispose = subscribeToAbort(signal, () => reject(signal.reason))
		})
		// Promise.race observes any late rejection. A late buffer is never searched.
		return await Promise.race([
			Promise.resolve().then(() => {
				signal.throwIfAborted()
				return read()
			}),
			cancelled,
		])
	} finally {
		dispose?.()
	}
}

function relativeInclude(include: string, root: string, sandboxed: boolean): string {
	let pattern = sandboxed ? include : include.split(sep).join('/')
	if (pattern.split('/').includes('..'))
		throw new Error('Include pattern escapes the search directory')
	if (sandboxed ? pattern.startsWith('/') : isAbsolute(include)) {
		const absolute = sandboxed ? resolveWithinPosix(root, pattern) : resolveWithin(root, include)
		pattern = sandboxed
			? relativePosix(root, absolute)
			: relative(root, absolute).split(sep).join('/')
	}
	while (pattern.startsWith('./')) pattern = pattern.slice(2)
	// Grep's existing unqualified include is recursive: *.ts means **/*.ts.
	return pattern.includes('/') ? pattern : `**/${pattern}`
}

const inputSchema = z.object({
	pattern: z.string().describe('Regular expression pattern to search for in file contents'),
	path: z
		.string()
		.optional()
		.describe('File or directory to search in. Defaults to the working directory.'),
	include: z
		.string()
		.optional()
		.describe('Glob pattern to filter files (e.g. "*.ts", "**/*.{js,jsx}")'),
	case_sensitive: z.boolean().default(true).describe('Whether the search is case-sensitive'),
	context_lines: z.coerce
		.number()
		.int()
		.min(0)
		.default(0)
		.describe('Number of lines to show before and after each match'),
	max_results: z.coerce
		.number()
		.int()
		.min(1)
		.default(100)
		.describe('Maximum number of matching lines to return'),
})

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5 MB — skip binaries/large files
const BINARY_CHECK_BYTES = 512
const MAX_VISITED_ENTRIES = 20_000

function isBinaryContent(buffer: Buffer): boolean {
	const check = buffer.subarray(0, BINARY_CHECK_BYTES)
	for (const byte of check) {
		if (byte === 0) return true
	}
	return false
}

export const GrepTool = defineTool({
	name: 'grep',
	description:
		'Searches file contents using a regular expression. Returns matching lines with file paths, line numbers, and optional context lines. Searches incrementally with a bounded traversal; identifies incomplete searches. Skips binary files, files over 5 MB, and symlinks. Choose the narrowest relevant directory.',
	inputSchema,
	category: 'analysis',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	presentCall(input) {
		if (typeof input.pattern !== 'string') return undefined
		return {
			kind: 'generic',
			label: `Search ${input.pattern} in ${input.path ?? '.'}`,
			presentation: 'activity',
			activity: 'exploration',
		}
	},
	timeoutMs: 15_000,

	async execute(input, context) {
		context.abortSignal?.throwIfAborted()
		const flags = input.case_sensitive ? 'g' : 'gi'
		let regex: RegExp
		try {
			regex = new RegExp(input.pattern, flags)
		} catch (err) {
			return {
				success: false,
				output: '',
				error: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
			}
		}

		const sandbox = context.sandbox
		const lexicalRoot = sandbox
			? resolveWithinPosix(sandbox.rootDir, input.path)
			: resolveWithinAny(toolRoots(context), input.path)
		const root = sandbox ? lexicalRoot : await resolveWithinAnyReal(toolRoots(context), input.path)
		const filePattern = relativeInclude(input.include ?? '**/*', lexicalRoot, sandbox !== undefined)
		const walkSandbox = sandbox?.walkFiles?.bind(sandbox)
		if (sandbox && !walkSandbox) {
			return {
				success: false,
				output: '',
				error:
					'This sandbox does not support bounded file discovery (Sandbox.walkFiles). Update its adapter before searching file contents.',
			}
		}
		const options: SandboxWalkFilesOptions = {
			pattern: filePattern,
			signal: context.abortSignal,
			maxEntries: MAX_VISITED_ENTRIES + 1,
			maxVisitedEntries: MAX_VISITED_ENTRIES,
			// Preserve existing source behavior: sandbox grep included dotfiles;
			// node's host glob excluded wildcard dotfiles.
			includeHidden: sandbox !== undefined,
		}
		const entries = walkSandbox ? walkSandbox(root, options) : walkFilesLocally(root, options)

		const results: string[] = []
		let totalMatches = 0
		let filesSearched = 0
		let filesMatched = 0

		let truncated = false
		let failure: string | undefined
		let unreadableFiles = 0
		try {
			for await (const entry of entries) {
				context.abortSignal?.throwIfAborted()
				const filePath = sandbox
					? resolveWithinPosix(root, entry.path)
					: resolveWithin(root, entry.path)
				if (filesSearched >= MAX_VISITED_ENTRIES) {
					throw new Error(
						`File search stopped after examining ${MAX_VISITED_ENTRIES} files; narrow its root or include pattern.`,
					)
				}
				filesSearched++
				if (entry.size > MAX_FILE_SIZE) continue

				let content: string
				try {
					const buffer = await readWithSignal(
						() =>
							sandbox
								? sandbox.readFile(filePath)
								: resolveWithinReal(root, filePath).then((contained) =>
										readFile(contained, { signal: context.abortSignal }),
									),
						context.abortSignal,
					)
					context.abortSignal?.throwIfAborted()
					if (buffer.length > MAX_FILE_SIZE || isBinaryContent(buffer)) continue
					content = buffer.toString('utf-8')
				} catch (error) {
					if (context.abortSignal?.aborted) throw error
					unreadableFiles++
					continue
				}

				const lines = content.split('\n')
				let fileHasMatch = false

				for (let i = 0; i < lines.length; i++) {
					context.abortSignal?.throwIfAborted()
					const line = lines[i] ?? ''
					regex.lastIndex = 0
					if (!regex.test(line)) continue

					if (!fileHasMatch) {
						fileHasMatch = true
						filesMatched++
					}

					const relPath = sandbox
						? `./${relativePosix(sandbox.rootDir, filePath)}`
						: `./${relative(context.workingDirectory, join(lexicalRoot, relative(root, filePath)))
								.split(sep)
								.join('/')}`

					if (input.context_lines > 0) {
						const start = Math.max(0, i - input.context_lines)
						const end = Math.min(lines.length - 1, i + input.context_lines)

						if (results.length > 0) {
							results.push('--')
						}

						for (let j = start; j <= end; j++) {
							const prefix = j === i ? ':' : '-'
							results.push(`${relPath}${prefix}${j + 1}${prefix}${lines[j]}`)
						}
					} else {
						results.push(`${relPath}:${i + 1}:${line}`)
					}

					totalMatches++
					if (totalMatches >= input.max_results) break
				}

				if (totalMatches >= input.max_results) {
					// Do not read another file just to prove there are more hits. Reaching
					// the requested cap means completeness was not established.
					truncated = true
					break
				}
			}
		} catch (error) {
			truncated = true
			failure = (error instanceof Error ? error.message : String(error)) || 'File search failed.'
		}
		if (unreadableFiles > 0) {
			truncated = true
			failure ??= `${unreadableFiles} file(s) could not be read.`
		}
		const summary =
			totalMatches > 0
				? `Found ${totalMatches} match(es) in ${filesMatched} file(s) (${filesSearched} files searched)`
				: truncated
					? `No matches found in the files searched for pattern "${input.pattern}"`
					: `No matches found for pattern "${input.pattern}"`
		const notice = failure
			? `[Search incomplete: ${failure}]`
			: truncated
				? `[Search incomplete: reached max_results (${input.max_results}). Narrow the directory or include pattern for a complete search.]`
				: undefined
		return {
			success: failure === undefined,
			output: [results.join('\n'), summary, notice].filter(Boolean).join('\n\n'),
			data: { totalMatches, filesSearched, filesMatched, truncated },
			...(failure ? { error: failure } : {}),
		}
	},
})
