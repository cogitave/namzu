/** Reading the classifier's answer. Anything that is not clearly a verdict is not one. */

export interface ParsedVerdict {
	readonly block: boolean
	/** The name of the rule the classifier says applies, for a block. */
	readonly rule?: string
	/** One plain sentence, for a block. */
	readonly reason?: string
}

const MAX_FIELD_CHARS = 300

function field(text: string, name: string): string | undefined {
	const pattern = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi')
	let last: string | undefined
	for (const match of text.matchAll(pattern)) last = match[1]
	const value = last?.replace(/\s+/g, ' ').trim()
	if (value === undefined || value === '') return undefined
	return value.length > MAX_FIELD_CHARS ? `${value.slice(0, MAX_FIELD_CHARS)}...` : value
}

/**
 * The verdict in `text`, or `undefined` when there is none to be read.
 *
 * Reasoning in a `<thinking>` element is removed first, so a verdict element
 * the model merely discussed there does not count. The LAST verdict outside it
 * wins. The closing tag is optional because the first pass stops on it. A
 * `<thinking>` that never closes means the answer was cut off before it
 * decided, and reads as no verdict.
 */
export function parseVerdict(text: string): ParsedVerdict | undefined {
	let visible = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ' ')
	if (/<thinking>/i.test(visible)) return undefined
	visible = visible.trim()
	let decided: string | undefined
	for (const match of visible.matchAll(/<verdict>\s*(block|allow)\b/gi)) decided = match[1]
	if (decided === undefined) return undefined
	if (decided.toLowerCase() === 'allow') return { block: false }
	const rule = field(visible, 'rule')
	const reason = field(visible, 'reason')
	return {
		block: true,
		...(rule !== undefined ? { rule } : {}),
		...(reason !== undefined ? { reason } : {}),
	}
}
