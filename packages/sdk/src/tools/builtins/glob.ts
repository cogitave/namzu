import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type { SandboxWalkFilesOptions } from '../../types/sandbox/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithin, resolveWithinAny, resolveWithinAnyReal, toolRoots } from '../paths.js'
import { relativePosix, resolveWithinPosix } from '../posix-path.js'

const MAX_GLOB_RESULTS = 500
const MAX_VISITED_ENTRIES = 20_000

const inputSchema = z.object({
	pattern: z
		.string()
		.min(1)
		.max(4096)
		.describe(
			'File glob relative to path. "*" lists immediate files; "**/*.ts" explicitly searches subdirectories. Supports braces and character classes. Known file paths can be read directly without discovery.',
		),
	path: z
		.string()
		.optional()
		.describe(
			'Directory to search in. Defaults to the working directory. Choose the narrowest relevant directory.',
		),
	include_hidden: z
		.boolean()
		.optional()
		.describe(
			'Include hidden files and directories in wildcard matches. Default: false. Explicit dotfile patterns still match.',
		),
})

/** Keep the pattern in the selected directory's coordinate system. */
function relativePattern(pattern: string, root: string, sandboxed: boolean): string {
	let result = sandboxed ? pattern : pattern.split(sep).join('/')
	if (result.split('/').includes('..')) {
		throw new Error(
			'Glob pattern escapes the search directory through "..". Choose a contained path and a relative pattern.',
		)
	}
	if (sandboxed ? result.startsWith('/') : isAbsolute(pattern)) {
		const contained = sandboxed ? resolveWithinPosix(root, result) : resolveWithin(root, pattern)
		result = sandboxed
			? relativePosix(root, contained)
			: relative(root, contained).split(sep).join('/')
	}
	while (result.startsWith('./')) result = result.slice(2)
	return result || '.'
}

/** Keep unusual filenames unambiguous without changing the returned path data. */
function displayPath(path: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: quote filenames containing control bytes instead of creating fake result lines.
	return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

export const GlobTool = defineTool({
	name: 'glob',
	description:
		'Finds regular files by glob pattern in a bounded search. "*" searches one directory; use "**" explicitly for recursive discovery. Returns at most 500 paths and identifies incomplete searches. Does not follow symlinks.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	timeoutMs: 15_000,

	presentCall(input) {
		if (typeof input.pattern !== 'string') return undefined
		return {
			kind: 'generic',
			label: `Find ${input.pattern} in ${input.path ?? '.'}`,
			presentation: 'activity',
			activity: 'exploration',
		}
	},

	async execute(input, context) {
		context.abortSignal?.throwIfAborted()
		const sandbox = context.sandbox
		const lexicalRoot = sandbox
			? resolveWithinPosix(sandbox.rootDir, input.path)
			: resolveWithinAny(toolRoots(context), input.path)
		const root = sandbox ? lexicalRoot : await resolveWithinAnyReal(toolRoots(context), input.path)
		const pattern = relativePattern(input.pattern, lexicalRoot, sandbox !== undefined)
		const walkSandbox = sandbox?.walkFiles?.bind(sandbox)
		if (sandbox && !walkSandbox) {
			return {
				success: false,
				output: '',
				error:
					'This sandbox does not support bounded file discovery (Sandbox.walkFiles). Update its adapter or use an available directory-listing command inside the sandbox.',
			}
		}
		const options: SandboxWalkFilesOptions = {
			pattern,
			signal: context.abortSignal,
			maxEntries: MAX_GLOB_RESULTS + 1,
			maxVisitedEntries: MAX_VISITED_ENTRIES,
			includeHidden: input.include_hidden ?? false,
		}
		const entries = walkSandbox ? walkSandbox(root, options) : walkFilesLocally(root, options)
		const files: string[] = []
		let truncated = false
		let failure: string | undefined
		try {
			for await (const entry of entries) {
				context.abortSignal?.throwIfAborted()
				const absolute = sandbox
					? resolveWithinPosix(root, entry.path)
					: resolveWithin(root, entry.path)
				if (files.length === MAX_GLOB_RESULTS) {
					truncated = true
					break
				}
				// Readers resolve relative input against the original working path,
				// which may be a symlink. Project back through the selected alias
				// before relativizing so added directories remain reachable.
				const file = sandbox
					? relativePosix(sandbox.rootDir, absolute)
					: relative(context.workingDirectory, join(lexicalRoot, relative(root, absolute)))
				files.push(`./${sandbox ? file : file.split(sep).join('/')}`)
			}
		} catch (error) {
			if (context.abortSignal?.aborted) throw error
			truncated = true
			failure = error instanceof Error ? error.message : String(error)
		}
		const notice = failure
			? `[Search incomplete: ${failure}]`
			: truncated
				? `[Showing the first ${MAX_GLOB_RESULTS} matching files. Narrow the directory or pattern for the remaining results.]`
				: undefined
		return {
			success: failure === undefined,
			output:
				[...files.map(displayPath), ...(notice ? [notice] : [])].join('\n') ||
				`No files found matching pattern "${input.pattern}" in ${root}`,
			data: { count: files.length, files, truncated, ...(sandbox ? { sandboxed: true } : {}) },
			...(failure ? { error: failure } : {}),
		}
	},
})
