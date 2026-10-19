import { readFile, stat } from 'node:fs/promises'
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

/** Entries returned when `head_limit` is not given. */
export const DEFAULT_HEAD_LIMIT = 250

/** A matching or context line longer than this is replaced by a notice, not printed. */
export const MAX_LINE_COLUMNS = 500

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
	output_mode: z
		.enum(['files_with_matches', 'content', 'count'])
		.default('files_with_matches')
		.describe(
			'What to return. "files_with_matches" (default): the paths of files that match, newest first. "content": matching lines with file and line number (supports context_lines). "count": the number of matching lines per file.',
		),
	head_limit: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			`Return at most this many entries (file paths, output lines, or count rows depending on output_mode). Defaults to ${DEFAULT_HEAD_LIMIT}. Pass 0 for no limit; use that sparingly, a large result wastes context.`,
		),
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.default(0)
		.describe('Skip this many entries before applying head_limit, to page through results.'),
	max_results: z.coerce
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Deprecated: use head_limit. Used as head_limit when head_limit is not given.'),
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
		'Searches file contents using a regular expression. By default returns the paths of matching files, newest first; output_mode "content" returns matching lines with file paths, line numbers and optional context lines, and "count" returns the number of matching lines per file. Results are paged: head_limit (default 250, 0 for none) and offset. A line over 500 characters is replaced by a notice. Searches with a bounded traversal and identifies incomplete searches. Skips binary files, files over 5 MB, and symlinks. Choose the narrowest relevant directory.',
	inputSchema,
	category: 'analysis',
	// Declared so a path outside the turn's roots can be reviewed before the
	// call runs, rather than refused after. See `ToolDefinition.pathArgument`.
	pathArgument: 'path',
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
			facts: {
				kind: 'search',
				pattern: input.pattern,
				...(input.path !== undefined ? { path: input.path } : {}),
			},
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

		// `execute` is reachable without the schema's defaults.
		const mode = input.output_mode ?? 'files_with_matches'
		// `max_results` predates `head_limit`; it keeps meaning "at most this many".
		const headLimit = input.head_limit ?? input.max_results ?? DEFAULT_HEAD_LIMIT
		const offset = input.offset ?? 0
		// Content lines in output order. Only content mode uses them as the
		// result; the other modes build from `matchedFiles`.
		const results: string[] = []
		const matchedFiles: { relPath: string; host?: string; count: number }[] = []
		let totalMatches = 0
		let filesSearched = 0
		let filesMatched = 0

		let truncated = false
		let pageHasMore = false
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
				let contained: string | undefined
				try {
					const buffer = await readWithSignal(
						() =>
							sandbox
								? sandbox.readFile(filePath)
								: resolveWithinReal(root, filePath).then((path) => {
										contained = path
										return readFile(path, { signal: context.abortSignal })
									}),
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
				let fileMatches = 0
				const relPath = sandbox
					? `./${relativePosix(sandbox.rootDir, filePath)}`
					: `./${relative(context.workingDirectory, join(lexicalRoot, relative(root, filePath)))
							.split(sep)
							.join('/')}`

				for (let i = 0; i < lines.length; i++) {
					context.abortSignal?.throwIfAborted()
					const line = lines[i] ?? ''
					regex.lastIndex = 0
					if (!regex.test(line)) continue

					if (fileMatches === 0) filesMatched++
					fileMatches++
					totalMatches++
					// A file list only needs to know that the file matches.
					if (mode === 'files_with_matches') break
					if (mode === 'count') continue

					if (input.context_lines > 0) {
						const start = Math.max(0, i - input.context_lines)
						const end = Math.min(lines.length - 1, i + input.context_lines)

						if (results.length > 0) {
							results.push('--')
						}

						for (let j = start; j <= end; j++) {
							const prefix = j === i ? ':' : '-'
							const text = lines[j] ?? ''
							results.push(
								`${relPath}${prefix}${j + 1}${prefix}${clipLine(text, j === i ? 'matching' : 'context')}`,
							)
						}
					} else {
						results.push(`${relPath}:${i + 1}:${clipLine(line, 'matching')}`)
					}

					// A full page ends the search: another file is not read just to
					// prove there is more, so a page that is exactly full is reported
					// as possibly continuing.
					if (headLimit > 0 && results.length >= offset + headLimit) {
						pageHasMore = true
						break
					}
				}

				if (fileMatches > 0 && mode !== 'content') {
					matchedFiles.push({
						relPath,
						...(contained !== undefined ? { host: contained } : {}),
						count: fileMatches,
					})
				}
				if (pageHasMore) break
			}
		} catch (error) {
			truncated = true
			failure = (error instanceof Error ? error.message : String(error)) || 'File search failed.'
		}
		if (unreadableFiles > 0) {
			truncated = true
			failure ??= `${unreadableFiles} file(s) could not be read.`
		}
		if (pageHasMore) truncated = true

		// Entries as the model will page through them.
		let entriesOut: string[]
		if (mode === 'content') {
			entriesOut = results
		} else if (mode === 'count') {
			entriesOut = matchedFiles.map((f) => `${f.relPath}:${f.count}`)
		} else {
			entriesOut = (await sortByNewest(matchedFiles)).map((f) => f.relPath)
		}
		const total = entriesOut.length
		const page =
			headLimit === 0 ? entriesOut.slice(offset) : entriesOut.slice(offset, offset + headLimit)
		// Reported only when it did something, like a `| head`: a limit that cut
		// nothing off is not news.
		const moreRemain = headLimit > 0 && (pageHasMore || total - offset > headLimit)
		const paging = [
			...(moreRemain ? [`limit: ${headLimit}`] : []),
			...(offset > 0 ? [`offset: ${offset}`] : []),
		].join(', ')

		let body: string
		let summary: string | undefined
		if (page.length === 0) {
			body = ''
			summary =
				offset > 0 && total > 0
					? 'No entries at this offset.'
					: truncated
						? `No matches found in the files searched for pattern "${input.pattern}"`
						: `No matches found for pattern "${input.pattern}"`
		} else if (mode === 'files_with_matches') {
			body = `Found ${page.length} ${page.length === 1 ? 'file' : 'files'}${paging ? ` (${paging})` : ''}\n${page.join('\n')}`
		} else if (mode === 'count') {
			body = page.join('\n')
			summary = `Found ${totalMatches} total ${totalMatches === 1 ? 'match' : 'matches'} across ${filesMatched} ${filesMatched === 1 ? 'file' : 'files'}${paging ? ` (${paging})` : ''}. ${filesSearched} files searched.`
		} else {
			body = page.join('\n')
			summary = `Found ${totalMatches} match(es) in ${filesMatched} file(s) (${filesSearched} files searched)${offset > 0 ? ` from offset ${offset}` : ''}`
		}
		const notice = failure
			? `[Search incomplete: ${failure}]`
			: pageHasMore
				? `[Search incomplete: the page of ${headLimit} is full, so more may follow. Pass offset to continue, or narrow the directory or include pattern.]`
				: truncated
					? '[Search incomplete: the search did not reach every file. Narrow the directory or include pattern for a complete search.]'
					: undefined
		return {
			success: failure === undefined,
			output: [body, summary, notice].filter(Boolean).join('\n\n'),
			data: {
				totalMatches,
				filesSearched,
				filesMatched,
				truncated,
				mode,
				...(moreRemain ? { appliedLimit: headLimit } : {}),
				...(offset > 0 ? { appliedOffset: offset } : {}),
			},
			facts: {
				kind: 'search',
				pattern: input.pattern,
				...(input.path !== undefined ? { path: input.path } : {}),
				matches: totalMatches,
				filesMatched,
				filesSearched,
				truncated,
			},
			...(failure ? { error: failure } : {}),
		}
	},
})

/** A line past the column cap is not printed: one minified bundle would be the whole result. */
function clipLine(line: string, kind: 'matching' | 'context'): string {
	return line.length > MAX_LINE_COLUMNS ? `[Omitted long ${kind} line]` : line
}

/**
 * Newest modification first; ties by path. A file that cannot be stat'ed, and
 * every file in a sandbox (which reports no modification time), sorts as
 * oldest, so a sandbox listing is in path order.
 */
async function sortByNewest<T extends { relPath: string; host?: string }>(
	files: readonly T[],
): Promise<T[]> {
	const stamped = await Promise.all(
		files.map(async (file) => {
			if (file.host === undefined) return { file, mtime: 0 }
			try {
				return { file, mtime: (await stat(file.host)).mtimeMs }
			} catch {
				return { file, mtime: 0 }
			}
		}),
	)
	return stamped
		.sort((a, b) => b.mtime - a.mtime || a.file.relPath.localeCompare(b.file.relPath))
		.map((entry) => entry.file)
}
