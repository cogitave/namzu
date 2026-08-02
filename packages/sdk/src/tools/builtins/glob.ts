import { glob } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Sandbox } from '../../types/sandbox/index.js'
import type { ToolResult } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { matchesGlob } from '../glob-match.js'
import { resolveWithin } from '../paths.js'
import { joinPosix, relativePosix, resolveWithinPosix } from '../posix-path.js'

/**
 * Cap on results, shared by both paths so a sandboxed search and a host
 * search truncate at the same point.
 */
const MAX_GLOB_RESULTS = 500

/**
 * Enumerate inside the sandbox and match there.
 *
 * This tool read the HOST filesystem through `node:fs` and referenced
 * `context.sandbox` nowhere, so with a container backend wired in the
 * sandbox was not a read boundary at all. The paths it returned were
 * host-relative too, while `read` resolves what it is given INSIDE the
 * sandbox — so every glob-to-read handoff either failed or opened a
 * different file. Every sibling builtin already remembers this branch.
 *
 * `listFiles` returns sandbox-relative paths, which is the coordinate
 * system `read` and `grep` already speak, so a path from here can be
 * handed straight to them.
 */
async function globInSandbox(
	input: { pattern: string; path?: string },
	sandbox: Sandbox,
): Promise<ToolResult> {
	// The sandbox's own coordinate system — see `posix-path`.
	const root = resolveWithinPosix(sandbox.rootDir, input.path)
	const entries = await sandbox.listFiles(root)

	let pattern = input.pattern
	if (!pattern.includes('/') && !pattern.startsWith('**/')) pattern = `**/${pattern}`

	const matches: string[] = []
	for (const entry of entries) {
		const relPath = relativePosix(sandbox.rootDir, joinPosix(root, entry.path))
		if (!matchesGlob(relPath, pattern)) continue
		matches.push(`./${relPath}`)
		if (matches.length >= MAX_GLOB_RESULTS) break
	}

	if (matches.length === 0) {
		return {
			success: true,
			output: `No files found matching pattern "${input.pattern}" in ${root}`,
			data: { count: 0, files: [], sandboxed: true },
		}
	}
	return {
		success: true,
		output: matches.join('\n'),
		data: { count: matches.length, files: matches, sandboxed: true },
	}
}

const inputSchema = z.object({
	pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
	path: z
		.string()
		.optional()
		.describe('Directory to search in. Defaults to the working directory if not specified.'),
})

function extractGlobBaseDirectory(pattern: string): {
	baseDir: string
	relativePattern: string
} {
	const globChars = /[*?[{]/
	const match = pattern.match(globChars)

	if (!match || match.index === undefined) {
		return { baseDir: dirname(pattern), relativePattern: basename(pattern) }
	}

	const staticPrefix = pattern.slice(0, match.index)
	const lastSepIndex = Math.max(staticPrefix.lastIndexOf('/'), staticPrefix.lastIndexOf(sep))

	if (lastSepIndex === -1) {
		return { baseDir: '', relativePattern: pattern }
	}

	const baseDir = staticPrefix.slice(0, lastSepIndex)
	const relativePattern = pattern.slice(lastSepIndex + 1)

	return { baseDir, relativePattern }
}

export const GlobTool = defineTool({
	name: 'glob',
	description: 'Searches for files using a glob pattern. Returns matching file paths.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		if (context.sandbox) {
			return await globInSandbox(input, context.sandbox)
		}

		// Contained, not merely resolved. This was a bare `resolve`, so
		// `path: "../../.."` reached whatever sits above the working
		// directory — with no sandbox needed to make it work.
		const basePath = resolveWithin(context.workingDirectory, input.path)

		let searchPath = basePath
		let pattern = input.pattern

		const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern)
		if (baseDir) {
			// A base directory lifted out of the PATTERN is caller-supplied
			// too: `pattern: "../../**/*.pem"` is the same escape wearing a
			// different argument.
			const resolvedPatternBase = resolveWithin(context.workingDirectory, baseDir)
			if (resolvedPatternBase === basePath || resolvedPatternBase.startsWith(`${basePath}/`)) {
				searchPath = resolvedPatternBase
				pattern = relativePattern
			}
		}

		if (!pattern.includes('/') && !pattern.startsWith('**/')) {
			pattern = `**/${pattern}`
		}

		const matches: string[] = []

		for await (const entry of glob(pattern, { cwd: searchPath })) {
			const absolutePath = resolve(searchPath, entry)
			matches.push(`./${relative(context.workingDirectory, absolutePath)}`)
			if (matches.length >= MAX_GLOB_RESULTS) break
		}

		if (matches.length === 0) {
			return {
				success: true,
				output: `No files found matching pattern "${input.pattern}" in ${searchPath}`,
				data: { count: 0, files: [] },
			}
		}

		return {
			success: true,
			output: matches.join('\n'),
			data: { count: matches.length, files: matches },
		}
	},
})
