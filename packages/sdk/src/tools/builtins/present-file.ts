import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'

/** How many files one call may hand over. */
export const MAX_PRESENTED_FILES = 10

const inputSchema = z.object({
	paths: z
		.array(z.string().min(1))
		.min(1)
		.max(MAX_PRESENTED_FILES)
		.describe('Paths of finished files to hand over. Each is one file, not a folder.'),
	caption: z
		.string()
		.max(300)
		.optional()
		.describe('One short line saying what the files are, shown beside them.'),
})

export interface PresentedFile {
	readonly path: string
	/** The file the path led to when it was checked, links followed. */
	readonly real: string
	readonly bytes: number
}

async function check(
	roots: readonly string[],
	requested: string,
): Promise<{ file: PresentedFile } | { refused: string }> {
	let real: string
	try {
		real = await resolveWithinAnyReal(roots, requested)
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error)
		return {
			refused: /escapes the working directory/.test(detail)
				? `${requested}: outside the folders this session may reach. Ask the person to add the folder, or copy the file into the work folder.`
				: `${requested}: ${detail}`,
		}
	}
	let info: Awaited<ReturnType<typeof stat>>
	try {
		info = await stat(real)
	} catch {
		return { refused: `${requested}: no such file.` }
	}
	if (info.isDirectory())
		return { refused: `${requested}: a folder, not a file. Name the files inside it.` }
	if (!info.isFile()) return { refused: `${requested}: not a regular file.` }
	try {
		await access(real, constants.R_OK)
	} catch {
		return { refused: `${requested}: the file cannot be read.` }
	}
	// The path the person would know (before links are followed), and where it led now: the host
	// shows the first and refuses the file if the second changes.
	return { file: { path: resolve(roots[0] as string, requested), real, bytes: info.size } }
}

/**
 * Hands finished files to the person. The call checks that each path is one
 * regular, readable file inside the folders the session reaches (a link that
 * leads out is judged by where it ends), then reports them as a `shared`
 * fact that a host draws as its own row or card. It copies nothing and
 * returns no bytes to the model.
 */
export const PresentFileTool: ToolDefinition<z.infer<typeof inputSchema>> = defineTool({
	name: 'present_file',
	description:
		"Hand finished files to the person only when they live outside the person's own folder (in the scratch folder) or should be opened right now: a file you wrote inside the person's own folder is already there, so say where it is instead. Each path must be a regular file, not a folder.",
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	presentCall: (input) => ({
		kind: 'generic',
		label: `Share ${input.paths.map((path) => basename(path)).join(', ')}`,
		presentation: 'activity',
	}),
	async execute(input, context) {
		if (context.sandbox) {
			const message =
				"present_file is not available in a sandboxed run: the files are not on the person's machine. Say where they are instead."
			return { success: false, output: message, error: message }
		}
		const roots = toolRoots(context)
		const files: PresentedFile[] = []
		const refused: string[] = []
		const seen = new Set<string>()
		for (const requested of input.paths) {
			const result = await check(roots, requested)
			if ('refused' in result) {
				refused.push(result.refused)
				continue
			}
			if (seen.has(result.file.path)) continue
			seen.add(result.file.path)
			files.push(result.file)
		}
		if (files.length === 0) {
			const message = `Nothing was shared.\n${refused.join('\n')}`
			return { success: false, output: message, error: message }
		}
		const lines = [
			`Shared ${files.map((file) => file.path).join(', ')}.`,
			...(refused.length > 0 ? [`Not shared:\n${refused.join('\n')}`] : []),
		]
		return {
			success: true,
			output: lines.join('\n'),
			facts: {
				kind: 'shared',
				files,
				...(input.caption ? { caption: input.caption } : {}),
			},
			data: { files, ...(input.caption ? { caption: input.caption } : {}) },
		}
	},
})
