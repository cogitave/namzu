/**
 * A connector's tool in the words a person reads: `slack · post`, not the name
 * the model calls it by. Anything that is not a connector tool is returned as
 * it came.
 */
export function connectorToolLabel(name: string): string {
	if (!name.startsWith('mcp__')) return name
	const rest = name.slice('mcp__'.length)
	const split = rest.indexOf('__')
	if (split <= 0 || split + 2 >= rest.length) return name
	return `${rest.slice(0, split)} · ${rest.slice(split + 2)}`
}

/** The argument names a person would call the point of a connector call, best first. */
const POINT_KEYS = [
	'query',
	'q',
	'text',
	'message',
	'title',
	'name',
	'subject',
	'channel',
	'url',
	'path',
	'id',
]

const SUMMARY_MAX = 60

/**
 * A few words about what a connector call is for, from its input: the value of
 * the first argument that names the point of the call, else the first text
 * argument, cut short. Nothing when the input holds no plain text.
 */
export function connectorCallSummary(input: unknown): string {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return ''
	const record = input as Record<string, unknown>
	const text = (value: unknown): string | undefined =>
		typeof value === 'string' && value.trim() !== '' ? value : undefined
	let chosen: string | undefined
	for (const key of POINT_KEYS) {
		chosen = text(record[key])
		if (chosen !== undefined) break
	}
	chosen ??= Object.values(record)
		.map(text)
		.find((value) => value !== undefined)
	if (chosen === undefined) return ''
	const flat = chosen.replace(/\s+/g, ' ').trim()
	return Array.from(flat).length > SUMMARY_MAX
		? `${Array.from(flat)
				.slice(0, SUMMARY_MAX - 1)
				.join('')}…`
		: flat
}

/**
 * The same, from a summary that was already made of the input (a raw
 * JSON object cut at some length, as an earlier version of a saved
 * conversation holds). A summary that is not JSON is already plain.
 */
export function plainConnectorSummary(summary: string): string {
	const trimmed = summary.trim()
	if (!trimmed.startsWith('{')) return summary
	try {
		return connectorCallSummary(JSON.parse(trimmed))
	} catch {
		return ''
	}
}
