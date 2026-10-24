import { createHash } from 'node:crypto'
import type { ToolDiffHunk, ToolResult } from '../../types/tool/index.js'
import { lineDiff } from './line-diff.js'

/** One side of a change, context included: the rows that exist before (`-`) or after (`+`). */
function previewSide(hunks: readonly ToolDiffHunk[], changed: '+' | '-'): string {
	return hunks
		.flatMap((hunk) => hunk.lines)
		.filter((row) => row.startsWith(' ') || row.startsWith(changed))
		.map((row) => `${row.slice(1)}\n`)
		.join('')
}

/** null means the backend could not establish the previous state. */
export function fileWriteResult(
	path: string,
	before: string | undefined | null,
	after: string,
	sandboxed = false,
): ToolResult {
	const operation =
		before === null
			? 'write'
			: before === undefined
				? 'create'
				: before === after
					? 'unchanged'
					: 'replace'
	// Counted from a real line diff of the whole file, not from the span
	// between the first and last changed line.
	const diff = lineDiff(typeof before === 'string' ? before : '', after)
	const known = before !== null
	const bytes = Buffer.byteLength(after, 'utf8')
	const label =
		operation === 'create'
			? 'Created'
			: operation === 'replace'
				? 'Updated'
				: operation === 'unchanged'
					? 'Unchanged'
					: 'Wrote'
	const newlineChanged =
		typeof before === 'string' && before.endsWith('\n') !== after.endsWith('\n')
	const summary = `${label} ${path}${before === null ? '' : ` (+${diff.added} -${diff.removed})`}${newlineChanged ? ' · final newline changed' : ''}`
	return {
		success: true,
		output: `${summary} · ${bytes} bytes`,
		facts: {
			kind: 'write',
			path,
			operation:
				operation === 'create'
					? 'created'
					: operation === 'replace'
						? 'updated'
						: operation === 'unchanged'
							? 'unchanged'
							: 'wrote',
			bytes,
			...(known
				? {
						added: diff.added,
						removed: diff.removed,
						...(diff.hunks.length > 0 ? { hunks: diff.hunks } : {}),
						...(diff.truncated ? { hunksTruncated: true as const } : {}),
					}
				: {}),
		},
		data: {
			path,
			size: after.length,
			...(sandboxed ? { sandboxed: true } : {}),
			fileChange: {
				operation,
				...(before === null
					? {}
					: {
							preview: {
								before: previewSide(diff.hunks, '-'),
								after: previewSide(diff.hunks, '+'),
							},
						}),
				bytes,
				sha256: createHash('sha256').update(after, 'utf8').digest('hex'),
				...(before === null ? {} : { added: diff.added, removed: diff.removed, newlineChanged }),
			},
		},
	}
}
