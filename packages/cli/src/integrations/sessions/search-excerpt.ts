/** A short single-line window of `excerpt` around the first place `query` appears in it. */
export function searchExcerpt(excerpt: string, query: string): string {
	const flat = excerpt.replace(/\s+/g, ' ').trim()
	const at = flat.toLowerCase().indexOf(query.toLowerCase())
	if (at < 0) return flat.length > 140 ? `${flat.slice(0, 139)}…` : flat
	let start = Math.max(0, at - 40)
	// Begin on a whole word when the window opens mid-word.
	if (start > 0) {
		const space = flat.indexOf(' ', start)
		if (space !== -1 && space < at) start = space + 1
	}
	const end = Math.min(flat.length, at + query.length + 80)
	return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/**
 * What the search list shows for one hit. A reply is shown as its text around the match. What a tool
 * returned can hold anything it read (a settings file, a key), and the list is always one keystroke
 * away, so a match inside tool output says only that it was found there.
 */
export function searchHitExcerpt(
	hit: { readonly source: string; readonly toolName?: string; readonly excerpt: string },
	query: string,
): string {
	if (hit.source === 'tool_completed' || hit.source.endsWith(':tool'))
		return hit.toolName
			? `Found in what “${hit.toolName}” returned`
			: 'Found in what a tool returned'
	return searchExcerpt(hit.excerpt, query)
}
