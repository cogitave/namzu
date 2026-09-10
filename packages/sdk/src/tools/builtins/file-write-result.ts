import { createHash } from 'node:crypto'
import type { ToolResult } from '../../types/tool/index.js'

/** A final newline terminates a line; it does not add an empty line. */
function lines(text: string): string[] {
	if (text === '') return []
	const result = text.split('\n')
	if (result.at(-1) === '') result.pop()
	return result
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
	const oldLines = lines(before ?? '')
	const newLines = lines(after)
	let start = 0
	let end = 0
	if (typeof before === 'string') {
		while (
			start < oldLines.length &&
			start < newLines.length &&
			oldLines[start] === newLines[start]
		)
			start++
		while (
			end < oldLines.length - start &&
			end < newLines.length - start &&
			oldLines[oldLines.length - end - 1] === newLines[newLines.length - end - 1]
		)
			end++
	}
	const removed = oldLines.slice(start, oldLines.length - end)
	const added = newLines.slice(start, newLines.length - end)
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
	const summary = `${label} ${path}${before === null ? '' : ` (+${added.length} -${removed.length})`}${newlineChanged ? ' · final newline changed' : ''}`
	return {
		success: true,
		output: `${summary} · ${bytes} bytes`,
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
								before: removed.length ? `${removed.join('\n')}\n` : '',
								after: added.length ? `${added.join('\n')}\n` : '',
							},
						}),
				bytes,
				sha256: createHash('sha256').update(after, 'utf8').digest('hex'),
				...(before === null
					? {}
					: { added: added.length, removed: removed.length, newlineChanged }),
			},
		},
	}
}
