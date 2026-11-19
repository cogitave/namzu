import { prepareIndex, searchFiles } from '../file-panel/file-search.js'
import type { FileHit } from '../file-panel/file-search.js'

export const GO_TO_LIMIT = 100

/** The files "Go to file" lists for what was typed, best first, and how many more did not fit. */
export function goToFileRows(
	paths: readonly string[],
	query: string,
): { rows: FileHit[]; more: number } {
	const index = prepareIndex(paths)
	const hits = searchFiles(index, query, paths.length || 1)
	return { rows: hits.slice(0, GO_TO_LIMIT), more: Math.max(0, hits.length - GO_TO_LIMIT) }
}
