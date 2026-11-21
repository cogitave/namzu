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

/**
 * A path cut in the middle, keeping its first folder and its file name: the
 * two ends are what say where it is and what it is. Cutting resumes at a
 * separator so the leaf is never split.
 */
export function shortenPathMiddle(path: string, max: number): string {
	if (max <= 0) return ''
	if (path.length <= max) return path
	if (max < 8) return shortenPathToFit(path, max)
	const leafStart = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
	const leaf = leafStart >= 0 ? path.slice(leafStart) : ''
	// A leaf that alone does not fit is cut from its left, as any long path is.
	if (leaf.length === 0 || leaf.length > max - 4) return shortenPathToFit(path, max)
	const head = path.slice(0, max - leaf.length - 1)
	const slash = Math.max(head.lastIndexOf('/'), head.lastIndexOf('\\'))
	// Snap to a separator when one is near the cut.
	const kept = slash > 0 && head.length - slash <= 12 ? head.slice(0, slash) : head
	return `${kept}…${leaf}`
}
