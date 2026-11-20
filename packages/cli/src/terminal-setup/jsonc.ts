/**
 * Just enough JSON-with-comments to add one entry to an editor's keybinding or
 * settings file without disturbing the comments and layout the person wrote.
 */

/** The text with comments and trailing commas removed, ready for `JSON.parse`. */
export function stripJsonc(text: string): string {
	let out = ''
	let i = 0
	while (i < text.length) {
		const c = text[i] as string
		if (c === '"') {
			const end = stringEnd(text, i)
			out += text.slice(i, end)
			i = end
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++
		} else if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2)
			i = close === -1 ? text.length : close + 2
		} else {
			out += c
			i++
		}
	}
	return out.replace(/,(\s*[\]}])/g, '$1')
}

function stringEnd(text: string, start: number): number {
	let i = start + 1
	while (i < text.length) {
		if (text[i] === '\\') i += 2
		else if (text[i] === '"') return i + 1
		else i++
	}
	return text.length
}

export function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonc(text))
}

/** The text with every comment blanked to spaces, so offsets still line up with the original. */
function maskComments(text: string): string {
	let out = ''
	let i = 0
	while (i < text.length) {
		const c = text[i] as string
		if (c === '"') {
			const end = stringEnd(text, i)
			out += text.slice(i, end)
			i = end
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				out += ' '
				i++
			}
		} else if (c === '/' && text[i + 1] === '*') {
			const close = text.indexOf('*/', i + 2)
			const end = close === -1 ? text.length : close + 2
			out += text.slice(i, end).replace(/[^\n]/g, ' ')
			i = end
		} else {
			out += c
			i++
		}
	}
	return out
}

/** Quoted text is hidden too, so a bracket inside a string is never taken for a closer. */
function maskStrings(masked: string): string {
	let out = ''
	let i = 0
	while (i < masked.length) {
		if (masked[i] === '"') {
			const end = stringEnd(masked, i)
			out += '"'.padEnd(end - i, 'x')
			i = end
		} else {
			out += masked[i]
			i++
		}
	}
	return out
}

function insertBefore(text: string, closer: ']' | '}', item: string, open: '[' | '{'): string {
	const code = maskStrings(maskComments(text))
	const at = code.lastIndexOf(closer)
	const openAt = code.indexOf(open)
	if (at === -1 || openAt === -1 || openAt > at) return ''
	const between = code.slice(openAt + 1, at)
	const filled = between.trim().length > 0
	const lastCodeChar = openAt + 1 + between.trimEnd().length - 1
	const needsComma = filled && code[lastCodeChar] !== ','
	const before = needsComma
		? `${text.slice(0, lastCodeChar + 1)},${text.slice(lastCodeChar + 1, at).replace(/\s+$/, '')}`
		: text.slice(0, at).replace(/\s+$/, '')
	return `${before}\n${item}\n${text.slice(at)}`
}

/** Add one element (already indented JSON) to the top-level array. Empty string when there is none. */
export function appendToArray(text: string, itemJson: string): string {
	return insertBefore(text, ']', itemJson, '[')
}

/** Add one `"key": value` member (already indented) to the top-level object. */
export function addToObject(text: string, memberJson: string): string {
	return insertBefore(text, '}', memberJson, '{')
}
