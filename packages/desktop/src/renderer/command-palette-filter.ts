export interface CommandSearchEntry {
	label: string
	group: string
	keywords?: readonly string[]
	meta?: string
}

/** Match every search term across the title and the host-provided context. */
export function matchesCommandQuery(
	item: CommandSearchEntry,
	query: string,
	contains: (text: string, term: string) => boolean,
): boolean {
	const terms = query.trim().split(/\s+/).filter(Boolean)
	const text = [item.label, item.group, item.meta, ...(item.keywords ?? [])]
		.filter(Boolean)
		.join(' ')
	return terms.every((term) => contains(text, term))
}

/** A displayed chord is actionable only when its exact modifiers match. */
export function matchesCommandShortcut(
	shortcut: readonly string[] | undefined,
	event: {
		key: string
		code?: string
		ctrlKey: boolean
		metaKey: boolean
		altKey: boolean
		shiftKey: boolean
	},
): boolean {
	if (!shortcut || shortcut.length < 2) return false
	const parts = shortcut.map((part) => part.toLowerCase())
	const key = parts.at(-1)
	const modifiers = new Set(parts.slice(0, -1))
	if ([...modifiers].some((part) => !['ctrl', 'cmd', 'alt', 'shift'].includes(part))) return false
	// The backtick and the backslash are matched by the key's place, as a shifted key reports another character.
	const byPlace =
		(key === '`' && event.code === 'Backquote') || (key === '\\' && event.code === 'Backslash')
	return (
		(event.key.toLowerCase() === key || byPlace) &&
		event.ctrlKey === modifiers.has('ctrl') &&
		event.metaKey === modifiers.has('cmd') &&
		event.altKey === modifiers.has('alt') &&
		event.shiftKey === modifiers.has('shift')
	)
}
