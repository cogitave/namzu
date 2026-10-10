import Anser from 'anser'

/**
 * What a tool printed, made fit to show a person.
 *
 * Output arrives as the terminal would have drawn it: colour escapes, cursor
 * moves, progress bars rewritten with a carriage return, and sometimes not text
 * at all. Nothing here reads the model's wording; it only decides how bytes
 * that came from a program are drawn.
 */

/** Operating-system commands (window titles, hyperlinks) and string terminators; anser leaves these in. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const OSC = /\u001b[\]P^_X][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
/** A lone carriage return rewrites the line, so only what follows the last one is on screen. */
const REWRITE = /[^\n\r]*\r(?=[^\n\r])/g

/** Drops every escape that is not a colour, and what a rewritten line no longer shows. */
export function cleanTerminalText(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(OSC, '').replace(REWRITE, '')
}

/** The text without any colour, for headlines, tooltips and screen readers. */
export function plainTerminalText(text: string): string {
	return Anser.ansiToText(cleanTerminalText(text))
}

export interface OutputSpan {
	text: string
	/** A palette class such as `ansi-red`; the stylesheet gives it a colour that reads on either theme. */
	fg?: string
	bg?: string
	/** A colour the program chose exactly (256 or true colour), as `r, g, b`. */
	fgRgb?: string
	bgRgb?: string
	bold?: boolean
	dim?: boolean
	italic?: boolean
	underline?: boolean
}

/** The colour of entry `index` in the 256-colour palette, for the entries past the sixteen named ones. */
function paletteRgb(index: number): string {
	if (index >= 232) {
		const level = 8 + (index - 232) * 10
		return `${level}, ${level}, ${level}`
	}
	const cube = index - 16
	const step = (n: number) => (n === 0 ? 0 : 55 + n * 40)
	return `${step(Math.floor(cube / 36))}, ${step(Math.floor(cube / 6) % 6)}, ${step(cube % 6)}`
}

/** A palette class from the parser as a colour: `ansi-palette-208` is entry 208. */
function paletteColour(name: string | null | undefined): string | undefined {
	const match = /^ansi-palette-(\d+)$/.exec(name ?? '')
	return match ? paletteRgb(Number(match[1])) : undefined
}

/** Colour and weight as separate runs of text, ready to draw without touching HTML. */
export function outputSpans(text: string): OutputSpan[] {
	const cleaned = cleanTerminalText(text)
	return Anser.ansiToJson(cleaned, {
		json: true,
		remove_empty: true,
		use_classes: true,
	}).map((entry) => {
		// The parser tracks reverse video but does not type it.
		const part = entry as typeof entry & { isInverted?: boolean }
		// Reverse video swaps the two colours; the program asked for it, so it is drawn.
		const fgName = part.isInverted ? part.bg : part.fg
		const bgName = part.isInverted ? part.fg : part.bg
		const fgRgb = (part.isInverted ? part.bg_truecolor : part.fg_truecolor) ?? paletteColour(fgName)
		const bgRgb = (part.isInverted ? part.fg_truecolor : part.bg_truecolor) ?? paletteColour(bgName)
		const named = (name: string | null | undefined) =>
			name && !name.startsWith('ansi-palette-') ? name : undefined
		return {
			text: part.content,
			...(named(fgName) && !fgRgb ? { fg: named(fgName) as string } : {}),
			...(named(bgName) && !bgRgb
				? { bg: (named(bgName) as string).replace('ansi-', 'ansi-bg-') }
				: {}),
			...(fgRgb ? { fgRgb } : {}),
			...(bgRgb ? { bgRgb } : {}),
			...(part.decorations.includes('bold') ? { bold: true } : {}),
			...(part.decorations.includes('dim') ? { dim: true } : {}),
			...(part.decorations.includes('italic') ? { italic: true } : {}),
			...(part.decorations.includes('underline') ? { underline: true } : {}),
		}
	})
}

/** A NUL, or a noticeable share of characters no terminal prints, means these are bytes and not text. */
export function looksBinaryText(text: string): boolean {
	const sample = text.length > 8000 ? text.slice(0, 8000) : text
	if (!sample) return false
	let odd = 0
	for (let index = 0; index < sample.length; index++) {
		const code = sample.charCodeAt(index)
		if (code === 0) return true
		if (code === 0xfffd || code === 0x7f) odd++
		else if (code < 0x20 && ![7, 8, 9, 10, 12, 13, 27].includes(code)) odd++
	}
	return odd / sample.length > 0.02
}

/** "3 KB", "1.2 MB": a size a person reads, never a byte count. A kilobyte is 1,000 bytes. */
export function humanBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return ''
	if (bytes < 1000) return `${bytes} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let value = bytes / 1000
	let unit = 0
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000
		unit += 1
	}
	const rounded =
		value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
	return `${rounded} ${units[unit]}`
}

export interface OutputWindow {
	/** The first lines. */
	head: string
	/** The last lines, when some were left out between. */
	tail?: string
	/** Lines left out between `head` and `tail`. */
	hidden: number
	/** Lines in the whole output. */
	total: number
}

/** Lines shown before "Show more", from the start and from the end. */
export const COLLAPSED_HEAD_LINES = 8
export const COLLAPSED_TAIL_LINES = 4

/**
 * The first and last lines of an output, with a count of the ones between. Output short enough
 * to read whole comes back whole.
 */
export function collapseOutput(
	text: string,
	head = COLLAPSED_HEAD_LINES,
	tail = COLLAPSED_TAIL_LINES,
): OutputWindow {
	const body = text.endsWith('\n') ? text.slice(0, -1) : text
	const lines = body === '' ? [] : body.split('\n')
	if (lines.length <= head + tail + 1) return { head: body, hidden: 0, total: lines.length }
	return {
		head: lines.slice(0, head).join('\n'),
		tail: lines.slice(lines.length - tail).join('\n'),
		hidden: lines.length - head - tail,
		total: lines.length,
	}
}
