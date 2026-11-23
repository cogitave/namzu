/**
 * What a person reads of a tool result that reached the model inside a frame
 * marking where its text came from. The frame is for the model: a row shows
 * the words inside it, never the opening or closing tag.
 *
 * Display only. The model's own copy is never passed through here. The
 * reader is tolerant where the SDK's strict one is not (a frame with text
 * around it, several frames, a frame inside a JSON string), because a leaked
 * tag on screen is worse than a frame read a little too generously.
 */

const OPENING = /<namzu-untrusted-([0-9a-f]+)(?: [^>]*)?>/g
const STRAY_CLOSING = /<\/namzu-untrusted-[0-9a-f]+>/g

function stripFrames(text: string): string {
	if (!text.includes('namzu-untrusted')) return text
	let out = ''
	let at = 0
	OPENING.lastIndex = 0
	for (let open = OPENING.exec(text); open !== null; open = OPENING.exec(text)) {
		if (open.index < at) continue
		const closing = `</namzu-untrusted-${open[1]}>`
		// Two lines of the frame's own words come first, and one of them names the
		// closing tag, so the tag is looked for only after the blank line that ends them.
		const bodyStart = text.indexOf('\n\n', open.index + open[0].length)
		if (bodyStart < 0) continue
		const end = text.indexOf(closing, bodyStart + 2)
		if (end < 0) continue
		const body = text.slice(bodyStart + 2, end).trim()
		out += text.slice(at, open.index) + body
		at = end + closing.length
		OPENING.lastIndex = at
	}
	return (out + text.slice(at)).replace(STRAY_CLOSING, '')
}

function stripJsonStrings(value: unknown): unknown {
	if (typeof value === 'string') return stripFrames(value)
	if (Array.isArray(value)) return value.map(stripJsonStrings)
	if (value && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripJsonStrings(v)]))
	}
	return value
}

export function withoutUntrustedFrames(text: string): string {
	if (!text.includes('namzu-untrusted')) return text
	const trimmed = text.trim()
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			return JSON.stringify(stripJsonStrings(JSON.parse(trimmed)))
		} catch {
			// Not JSON after all: read it as text.
		}
	}
	return stripFrames(text)
}
