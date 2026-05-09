import { glob } from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'

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
		const basePath = input.path
			? resolve(context.workingDirectory, input.path)
			: context.workingDirectory

		let searchPath = basePath
		let pattern = input.pattern

		const { baseDir, relativePattern } = extractGlobBaseDirectory(pattern)
		if (baseDir) {
			const resolvedPatternBase = resolve(context.workingDirectory, baseDir)
			if (resolvedPatternBase === basePath || resolvedPatternBase.startsWith(`${basePath}/`)) {
				searchPath = resolvedPatternBase
				pattern = relativePattern
			}
		}

		if (!pattern.includes('/') && !pattern.startsWith('**/')) {
			pattern = `**/${pattern}`
		}

		const matches: string[] = []
		const MAX_RESULTS = 500

		for await (const entry of glob(pattern, { cwd: searchPath })) {
			const absolutePath = resolve(searchPath, entry)
			matches.push(`./${relative(context.workingDirectory, absolutePath)}`)
			if (matches.length >= MAX_RESULTS) break
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
