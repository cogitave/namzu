import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

const MAX_LINE_BYTES = 1024 * 1024

/** Explicit streamed input uses Namzu's user-message fields, never runtime provenance. */
function userText(line: string, number: number): string {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch {
		throw new Error(`stdin line ${number}: expected a JSON user message`)
	}
	if (
		value === null ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		!('role' in value) ||
		value.role !== 'user' ||
		!('content' in value) ||
		typeof value.content !== 'string' ||
		!value.content.trim() ||
		Object.keys(value).some((key) => !['role', 'content', 'timestamp'].includes(key)) ||
		('timestamp' in value &&
			(typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)))
	)
		throw new Error(
			`stdin line ${number}: expected {"role":"user","content":"..."} with optional timestamp`,
		)
	return value.content
}

/** Yield at each newline, without waiting for EOF; bound incomplete lines before allocation. */
export async function* streamUserInput(input: Readable): AsyncGenerator<string> {
	const decoder = new StringDecoder('utf8')
	let pending = ''
	let number = 0
	for await (const chunk of input) {
		const text = typeof chunk === 'string' ? chunk : decoder.write(chunk)
		let start = 0
		for (let end = text.indexOf('\n'); end !== -1; end = text.indexOf('\n', start)) {
			const part = text.slice(start, end)
			if (Buffer.byteLength(pending) + Buffer.byteLength(part) > MAX_LINE_BYTES)
				throw new Error('stdin message exceeds 1 MiB')
			const line = pending + part
			pending = ''
			number += 1
			if (line.trim()) yield userText(line, number)
			start = end + 1
		}
		const tail = text.slice(start)
		if (Buffer.byteLength(pending) + Buffer.byteLength(tail) > MAX_LINE_BYTES)
			throw new Error('stdin message exceeds 1 MiB')
		pending += tail
	}
	pending += decoder.end()
	if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw new Error('stdin message exceeds 1 MiB')
	if (pending.trim()) yield userText(pending, number + 1)
}
