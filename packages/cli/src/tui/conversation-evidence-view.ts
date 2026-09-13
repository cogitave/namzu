/** TUI only: the model and durable tool receipt keep the original JSON. */
export function conversationEvidenceView(
	toolName: string,
	output: string,
): { content: string; detail: readonly string[] } | undefined {
	if (toolName !== 'search_conversation' && toolName !== 'read_conversation') return undefined
	let value: unknown
	try {
		value = JSON.parse(output)
	} catch {
		return undefined
	}
	if (!record(value)) return undefined
	const rows = toolName === 'search_conversation' ? searchRows(value) : readRows(value)
	if (!rows) return undefined
	return { content: rows.join('\n'), detail: JSON.stringify(value, null, 2).split('\n') }
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function preview(text: string, limit = 96): string {
	const units = Array.from(text.replace(/\s+/gu, ' ').trim())
	return units.length > limit ? `${units.slice(0, limit - 1).join('')}…` : units.join('')
}

function sourceLabel(value: Record<string, unknown>): string {
	switch (value.recordKind) {
		case 'assistant_message':
			return 'Assistant message'
		case 'user_message':
			return 'User message'
		case 'system_message':
			return 'System message'
		case 'derived_summary':
			return 'Derived summary'
		case 'tool_result':
			return `Tool result${typeof value.toolName === 'string' ? ` (${preview(value.toolName, 48)})` : ''}`
		default:
			return 'Source unknown'
	}
}

function searchRows(value: Record<string, unknown>): string[] | undefined {
	if (
		!Array.isArray(value.matches) ||
		!value.matches.every((match) => record(match) && typeof match.text === 'string') ||
		typeof value.incomplete !== 'boolean' ||
		!count(value.unavailableRuns)
	)
		return undefined
	const rows = [`Conversation search · ${value.matches.length} matches on this page`]
	rows.push(
		value.incomplete || value.nextCursor
			? `Search incomplete${value.nextCursor ? ' · more to scan' : ''} · absence is inconclusive`
			: 'Traversal finished within selected sources',
	)
	if (value.unavailableRuns > 0) rows.push(`${value.unavailableRuns} run(s) unavailable`)
	for (const match of value.matches.slice(0, 3)) {
		rows.push(
			`${sourceLabel(match)}${match.retained === 'preview' ? ' · preview flagged' : ''}${match.isError === true ? ' · original reported error' : ''}: ${preview(match.text)}`,
		)
	}
	if (value.matches.length > 3) rows.push(`+${value.matches.length - 3} more matches in details`)
	return rows
}

function readRows(value: Record<string, unknown>): string[] | undefined {
	if (
		typeof value.text !== 'string' ||
		typeof value.complete !== 'boolean' ||
		typeof value.retainedPreview !== 'boolean' ||
		!count(value.offset)
	)
		return undefined
	const rows = [`Conversation read · ${sourceLabel(value)}`]
	if (value.retainedPreview) rows.push('Preview flagged · original may be incomplete')
	if (!value.complete) {
		rows.push(
			value.nextCursor
				? value.text.length === 0
					? 'Locating retained text · continue scan'
					: 'Partial page · more retained text available'
				: 'Read incomplete · no continuation supplied',
		)
	} else {
		rows.push(
			value.offset > 0
				? 'Last page · earlier text is not on this page'
				: 'Selected retained part returned',
		)
	}
	if (value.recordKind === 'tool_result') {
		rows.push(
			value.isError === true
				? 'Original tool reported an error'
				: value.isError === false
					? 'Original tool reported no error'
					: 'Original tool status unknown',
		)
	}
	if (value.text.length > 0) rows.push(`Excerpt: ${preview(value.text, 160)}`)
	return rows
}
