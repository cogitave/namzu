import { isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { walkFilesLocally } from '../../sandbox/file-walk.js'
import type { SandboxWalkFilesOptions, SandboxWalkSummary } from '../../types/sandbox/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithin, resolveWithinAny, resolveWithinAnyReal, toolRoots } from '../paths.js'
import { relativePosix, resolveWithinPosix } from '../posix-path.js'
import {
	SEARCH_BUDGET_MS,
	hostDisplayPath,
	ignoredHint,
	isEntryLimit,
	isReadDenied,
	openSearchBudget,
	plural,
	quoteControlPath,
	stoppedNotice,
} from './search-support.js'

const MAX_GLOB_RESULTS = 500

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
			'Include hidden files and directories in wildcard matches. Default: true. Version-control directories are always skipped.',
		),
	include_ignored: z
		.boolean()
		.optional()
		.describe(
			'Also return files that .gitignore and .ignore rules exclude, such as build output and dependencies. Default: false.',
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

export const GlobTool = defineTool({
	name: 'glob',
	description:
		'Finds regular files by glob pattern in a bounded search. "*" searches one directory; use "**" explicitly for recursive discovery. Skips files that .gitignore and .ignore rules exclude unless include_ignored is set, and files the read rules of the session deny. Returns at most 500 paths and says when a result is limited or a search stopped early. Does not follow symlinks. To search inside files, use grep.',
	inputSchema,
	category: 'filesystem',
	// Declared so a path outside the turn's roots can be reviewed before the
	// call runs, rather than refused after. See `ToolDefinition.pathArgument`.
	pathArgument: 'path',
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
			facts: {
				kind: 'list',
				pattern: input.pattern,
				...(input.path !== undefined ? { path: input.path } : {}),
			},
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
		const budget = openSearchBudget(context.abortSignal)
		let summary: SandboxWalkSummary | undefined
		const options: SandboxWalkFilesOptions = {
			pattern,
			signal: budget.signal,
			maxEntries: MAX_GLOB_RESULTS + 1,
			includeHidden: input.include_hidden ?? true,
			respectIgnore: input.include_ignored !== true,
			onSummary: (value) => {
				summary = value
			},
		}
		const entries = walkSandbox ? walkSandbox(root, options) : walkFilesLocally(root, options)
		const files: string[] = []
		let capped = false
		let timedOut = false
		let legacyEntryLimit = false
		let failure: string | undefined
		try {
			for await (const entry of entries) {
				budget.signal.throwIfAborted()
				const absolute = sandbox
					? resolveWithinPosix(root, entry.path)
					: resolveWithin(root, entry.path)
				if (isReadDenied(context, absolute, sandbox?.rootDir)) continue
				if (files.length === MAX_GLOB_RESULTS) {
					capped = true
					break
				}
				// Readers resolve relative input against the original working path,
				// which may be a symlink. Project back through the selected alias
				// before relativizing so added directories remain reachable.
				files.push(
					sandbox
						? relativePosix(sandbox.rootDir, absolute)
						: hostDisplayPath(
								context.workingDirectory,
								join(lexicalRoot, relative(root, absolute)),
							),
				)
			}
		} catch (error) {
			if (context.abortSignal?.aborted) throw error
			if (budget.expired()) timedOut = true
			else if (isEntryLimit(error)) legacyEntryLimit = true
			else failure = error instanceof Error ? error.message : String(error)
		} finally {
			budget.close()
		}
		const endState = summary as SandboxWalkSummary | undefined
		const entryLimit = endState?.stopped === 'entry-limit' || legacyEntryLimit
		const incomplete = timedOut || entryLimit
		if (timedOut && files.length === 0) {
			return {
				success: false,
				output: '',
				error: `Search timed out after ${SEARCH_BUDGET_MS / 1000} seconds with no matches. Try a more specific path or pattern.`,
			}
		}
		const notices = [
			...(capped
				? [
						`(Showing the first ${plural(MAX_GLOB_RESULTS, 'matching file')}; more match. Narrow the pattern or path to see the rest.)`,
					]
				: []),
			...(incomplete ? [stoppedNotice(timedOut ? 'time' : 'entries', endState?.visited)] : []),
			...(failure ? [`[Search incomplete: ${failure}]`] : []),
		]
		const ignored = endState?.ignoredDirectories ?? 0
		const hint = ignored > 0 ? `\n${ignoredHint(ignored)}` : ''
		const empty = `No files found matching pattern "${input.pattern}" in ${root}${hint}`
		return {
			success: failure === undefined,
			output: [...files.map(quoteControlPath), ...notices].join('\n') || empty,
			data: {
				count: files.length,
				files,
				truncated: capped || incomplete,
				...(sandbox ? { sandboxed: true } : {}),
			},
			facts: {
				kind: 'list',
				pattern: input.pattern,
				...(input.path !== undefined ? { path: input.path } : {}),
				count: files.length,
				truncated: capped || incomplete,
				...(capped ? { limited: true } : {}),
				...(incomplete ? { incomplete: true } : {}),
			},
			...(failure ? { error: failure } : {}),
		}
	},
})
