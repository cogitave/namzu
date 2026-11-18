/**
 * The headings of a Markdown document, for the outline button of the document page. Read from the
 * text, so the list can be drawn without the page; a heading in a code block, in the front matter
 * or written as HTML is not one.
 */

export interface OutlineEntry {
	/** 1 to 4: the number of # marks. */
	level: number
	/** The heading as a person reads it, without Markdown marks. */
	text: string
	/** Which of the headings with this same text it is, counting from 0. */
	occurrence: number
}

/** Deepest heading the outline lists. */
export const OUTLINE_DEPTH = 4

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** A heading's text without links, images, code marks, emphasis or tags. */
export function plainHeading(raw: string): string {
	return raw
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, '')
		.replace(/`+([^`]*)`+/g, '$1')
		.replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
		.replace(/(^|[^\w*])(\*|_)(.+?)\2(?![\w*])/g, '$1$3')
		.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, '$1')
		.replace(/\s+/g, ' ')
		.trim()
}

export function documentOutline(markdown: string): OutlineEntry[] {
	const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
	let start = 0
	// Front matter: a first line of three dashes up to the next such line.
	if (lines[0]?.trim() === '---') {
		const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line))
		if (end > 0) start = end + 1
	}
	const entries: OutlineEntry[] = []
	const seen = new Map<string, number>()
	let fence: string | undefined
	for (let index = start; index < lines.length; index++) {
		const line = lines[index] as string
		const opened = FENCE.exec(line)
		if (fence) {
			// A fence closes with the same mark, at least as long, and nothing after it.
			if (
				opened &&
				opened[1]?.[0] === fence[0] &&
				opened[1].length >= fence.length &&
				!/\S/.test(line.slice(opened[0].length))
			)
				fence = undefined
			continue
		}
		if (opened) {
			fence = opened[1]
			continue
		}
		const match = HEADING.exec(line)
		if (!match) continue
		const level = (match[1] as string).length
		if (level > OUTLINE_DEPTH) continue
		const text = plainHeading(match[2] as string)
		if (!text) continue
		const occurrence = seen.get(text) ?? 0
		seen.set(text, occurrence + 1)
		entries.push({ level, text, occurrence })
	}
	return entries
}

/** How far each entry is indented: its level less the shallowest one in the list. */
export function outlineDepths(entries: readonly OutlineEntry[]): number[] {
	const top = Math.min(...entries.map((entry) => entry.level))
	return entries.map((entry) => entry.level - top)
}

/**
 * Which drawn heading an entry names. `drawn` is the text of every heading the page shows, in
 * order. Text decides, with repeats counted; when the page drew the heading differently, the
 * entry's own place in the list is the guess.
 */
export function drawnHeadingIndex(
	entries: readonly OutlineEntry[],
	index: number,
	drawn: readonly string[],
): number | undefined {
	const entry = entries[index]
	if (!entry) return undefined
	const same = (text: string) => text.replace(/\s+/g, ' ').trim()
	let skip = entry.occurrence
	for (let at = 0; at < drawn.length; at++) {
		if (same(drawn[at] as string) !== entry.text) continue
		if (skip === 0) return at
		skip -= 1
	}
	return drawn.length === entries.length ? index : undefined
}
