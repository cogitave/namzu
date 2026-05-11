import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'

const inputSchema = z.object({
	paths: z
		.array(z.string().min(1))
		.min(1)
		.describe('Expected output file paths to verify. Each path is checked for existence and size.'),
	min_bytes: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe(
			'Minimum acceptable file size in bytes. A file under this size counts as missing. Default: 1 (any non-empty file passes).',
		),
})

type Result = {
	path: string
	exists: boolean
	size_bytes?: number
	ok: boolean
	error?: string
}

export const VerifyOutputsTool = defineTool({
	name: 'verify_outputs',
	description:
		"Verify that a set of expected output files actually exist on disk and are non-empty. Use this BEFORE declaring multi-worker work done — pass every deliverable path the workers were supposed to produce. Returns a per-path report (exists, size_bytes, ok) plus an overall pass/fail summary. If any path fails, follow up with the responsible worker via `continue_task` — do NOT paper over a missing file in prose.",
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		const minBytes = input.min_bytes ?? 1
		const results: Result[] = await Promise.all(
			input.paths.map((path) => verifyOne({ path, minBytes, context })),
		)

		const passed = results.filter((r) => r.ok).length
		const failed = results.filter((r) => !r.ok)
		const summary = {
			total: results.length,
			passed,
			failed: failed.length,
			min_bytes: minBytes,
		}
		const lines = results.map((r) =>
			r.ok
				? `- OK   ${r.path}${typeof r.size_bytes === 'number' ? ` (${r.size_bytes}B)` : ''}`
				: `- FAIL ${r.path} — ${r.error ?? (r.exists ? `size ${r.size_bytes ?? 0}B < min ${minBytes}B` : 'missing')}`,
		)
		const header = `Verify outputs: ${passed}/${results.length} passed (min ${minBytes}B)`
		return {
			success: failed.length === 0,
			output: [header, '', ...lines].join('\n'),
			error:
				failed.length > 0
					? `${failed.length} of ${results.length} expected outputs failed verification`
					: undefined,
			data: { results, summary },
		}
	},
})

async function verifyOne(input: {
	path: string
	minBytes: number
	context: ToolContext
}): Promise<Result> {
	const { path, minBytes, context } = input
	if (context.sandbox) {
		try {
			const buffer = await context.sandbox.readFile(path)
			const size = buffer.byteLength
			return {
				path,
				exists: true,
				size_bytes: size,
				ok: size >= minBytes,
			}
		} catch (err) {
			return {
				path,
				exists: false,
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			}
		}
	}

	const filePath = resolve(context.workingDirectory, path)
	try {
		const info = await stat(filePath)
		if (!info.isFile()) {
			return {
				path,
				exists: true,
				ok: false,
				error: 'not a regular file',
			}
		}
		return {
			path,
			exists: true,
			size_bytes: info.size,
			ok: info.size >= minBytes,
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code
		if (code === 'ENOENT') return { path, exists: false, ok: false }
		return {
			path,
			exists: false,
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}
