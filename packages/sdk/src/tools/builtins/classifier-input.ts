/**
 * Shared helpers for `ToolDefinition.classifierInput`: what the auto-mode
 * classifier is shown of a call to a built-in tool.
 */

/** Cuts `text` to `limit` characters, saying how much was left out. */
export function clip(text: string, limit: number): string {
	if (text.length <= limit) return text
	return `${text.slice(0, limit)}... [${text.length - limit} more characters]`
}

/** The characters a change adds and removes, in a form short enough to read at a glance. */
export function describeChange(removed: string | undefined, added: string | undefined): string {
	const parts: string[] = []
	if (removed !== undefined && removed !== '')
		parts.push(`removes ${JSON.stringify(clip(removed, 200))}`)
	if (added !== undefined && added !== '') parts.push(`adds ${JSON.stringify(clip(added, 300))}`)
	return parts.length > 0 ? parts.join(', ') : 'no text change'
}
