/**
 * A path shortened from the LEFT, keeping the leaf.
 *
 * The end of a path is the informative end: `core` says which package you are
 * in, `/home` says nothing you did not know. Cutting resumes at a separator
 * when one is near the cut, so the result still reads as a path rather than as
 * a word broken in half.
 */
export function shortenPathToFit(path: string, max: number): string {
	if (max <= 0) return ''
	if (path.length <= max) return path
	if (max === 1) return '…'
	const tail = path.slice(-(max - 1))
	// A Windows path separates with a backslash.
	const slash = tail.search(/[\\/]/)
	// Only snap to a separator if one is close, or a long leading segment would
	// cost more than it explains.
	const snapped = slash >= 0 && slash <= 12 ? tail.slice(slash) : tail
	return `…${snapped}`
}
