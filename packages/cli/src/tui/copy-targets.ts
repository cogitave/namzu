/** A source-preserving target offered by `/copy`. */
export type CopyResponseTarget =
	| { readonly kind: 'whole'; readonly label: 'Whole response'; readonly text: string }
	| { readonly kind: 'code'; readonly label: string; readonly text: string }
	| { readonly kind: 'quote'; readonly label: 'Blockquote'; readonly text: string }

interface SourceLine {
	readonly body: string
	readonly ending: string
}

interface Fence {
	readonly marker: '`' | '~'
	readonly length: number
	readonly indent: number
	readonly quoteDepth: number
	readonly language?: string
}

interface PositionedTarget {
	readonly line: number
	/** A containing quote is offered before a fenced block inside it. */
	readonly priority: number
	readonly target: Exclude<CopyResponseTarget, { readonly kind: 'whole' }>
}

/**
 * Offer the exact response plus copyable Markdown regions in source order.
 *
 * This is deliberately a source scanner rather than a renderer walk. Clipboard
 * bytes retain CRLF, trailing whitespace and nested quote markers; Ink output
 * is never treated as a reversible representation of Markdown.
 */
export function copyTargetsForResponse(source: string): readonly CopyResponseTarget[] {
	const lines = sourceLines(source)
	const positioned: PositionedTarget[] = []

	for (let line = 0; line < lines.length; line += 1) {
		const opening = parseFence(lines[line]?.body ?? '')
		if (!opening) continue
		const body: string[] = []
		let cursor = line + 1
		for (; cursor < lines.length; cursor += 1) {
			const current = lines[cursor]
			if (!current) break
			const unquoted = stripQuoteDepth(current.body, opening.quoteDepth)
			// A fenced block inside an explicitly marked quote ends when the quote
			// itself ends, even when the author omitted a closing fence.
			if (unquoted === null) break
			if (isClosingFence(unquoted, opening)) {
				cursor += 1
				break
			}
			body.push(stripOpeningIndent(unquoted, opening.indent) + current.ending)
		}
		positioned.push({
			line,
			priority: 1,
			target: {
				kind: 'code',
				label: opening.language ? `${opening.language} code` : 'Code block',
				text: body.join(''),
			},
		})
		line = Math.max(line, cursor - 1)
	}

	for (let line = 0; line < lines.length; line += 1) {
		if (stripOneQuotePrefix(lines[line]?.body ?? '') === null) continue
		const content: SourceLine[] = []
		let cursor = line
		for (; cursor < lines.length; cursor += 1) {
			const current = lines[cursor]
			if (!current) break
			const stripped = stripOneQuotePrefix(current.body)
			if (stripped === null) break
			content.push({ body: stripped, ending: current.ending })
		}
		if (quoteHasProse(content)) {
			positioned.push({
				line,
				priority: 0,
				target: {
					kind: 'quote',
					label: 'Blockquote',
					text: content.map((part) => part.body + part.ending).join(''),
				},
			})
		}
		line = Math.max(line, cursor - 1)
	}

	positioned.sort((left, right) => left.line - right.line || left.priority - right.priority)
	return [
		{ kind: 'whole', label: 'Whole response', text: source },
		...positioned.map(({ target }) => target),
	]
}

function sourceLines(source: string): readonly SourceLine[] {
	const lines: SourceLine[] = []
	let start = 0
	while (start < source.length) {
		const lf = source.indexOf('\n', start)
		if (lf < 0) {
			lines.push({ body: source.slice(start), ending: '' })
			break
		}
		const crlf = lf > start && source.charCodeAt(lf - 1) === 0x0d
		lines.push({
			body: source.slice(start, crlf ? lf - 1 : lf),
			ending: crlf ? '\r\n' : '\n',
		})
		start = lf + 1
	}
	return lines
}

function parseFence(body: string): Fence | null {
	let rest = body
	let quoteDepth = 0
	for (;;) {
		const quoted = stripOneQuotePrefix(rest)
		if (quoted === null) break
		quoteDepth += 1
		rest = quoted
	}
	const indent = leadingSpaces(rest, 3)
	rest = rest.slice(indent)
	const marker = rest[0]
	if (marker !== '`' && marker !== '~') return null
	let length = 0
	while (rest[length] === marker) length += 1
	if (length < 3) return null
	const info = rest.slice(length).trim()
	if (marker === '`' && info.includes('`')) return null
	const language = info.split(/[\s,]/, 1)[0]
	return {
		marker,
		length,
		indent,
		quoteDepth,
		...(language ? { language } : {}),
	}
}

function isClosingFence(body: string, opening: Fence): boolean {
	const rest = body.slice(leadingSpaces(body, 3))
	let length = 0
	while (rest[length] === opening.marker) length += 1
	return length >= opening.length && rest.slice(length).trim().length === 0
}

function stripOpeningIndent(body: string, indent: number): string {
	return body.slice(leadingSpaces(body, indent))
}

function leadingSpaces(text: string, limit: number): number {
	let count = 0
	while (count < limit && text[count] === ' ') count += 1
	return count
}

function stripOneQuotePrefix(body: string): string | null {
	const indent = leadingSpaces(body, 3)
	if (body[indent] !== '>') return null
	const afterMarker = indent + 1
	return body.slice(afterMarker + (body[afterMarker] === ' ' ? 1 : 0))
}

function stripQuoteDepth(body: string, depth: number): string | null {
	let rest = body
	for (let index = 0; index < depth; index += 1) {
		const stripped = stripOneQuotePrefix(rest)
		if (stripped === null) return null
		rest = stripped
	}
	return rest
}

/** A code-only quote is already represented by its fenced-code target. */
function quoteHasProse(lines: readonly SourceLine[]): boolean {
	let fence: Fence | null = null
	for (const line of lines) {
		if (fence) {
			if (isClosingFence(stripQuoteDepth(line.body, fence.quoteDepth) ?? line.body, fence)) {
				fence = null
			}
			continue
		}
		const opening = parseFence(line.body)
		if (opening) {
			fence = opening
			continue
		}
		let visible = line.body
		for (;;) {
			const nested = stripOneQuotePrefix(visible)
			if (nested === null) break
			visible = nested
		}
		// Four leading spaces are an indented code block, not quoted prose.
		if (/^ {4}/.test(visible)) continue
		if (visible.trim().length > 0) return true
	}
	return false
}
