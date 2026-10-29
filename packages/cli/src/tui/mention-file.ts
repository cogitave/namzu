import {
	constants,
	closeSync,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from 'node:fs'
import { resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** Shared by every file in one composed message, including failed partial reads. */
export interface MentionReadBudget {
	bytes: number
}

const MAX_SCAN_BYTES = 8 * 1024 * 1024
const CHUNK_BYTES = 16 * 1024

/** Read only bounded chunks; a line range never requires retaining its preceding lines. */
export function readMentionFile(
	cwd: string,
	rel: string,
	range: { readonly start: number; readonly end: number } | undefined,
	maxChars: number,
	budget: MentionReadBudget,
): string | null {
	let fd: number | undefined
	try {
		const root = realpathSync(resolve(cwd))
		const abs = realpathSync(resolve(root, rel))
		const inside = (path: string): boolean => path === root || path.startsWith(root + sep)
		if (!inside(abs)) return null
		const before = statSync(abs)
		if (!before.isFile()) return null
		// Never block on a replacement FIFO or follow a replacement final symlink.
		fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
		const opened = fstatSync(fd)
		if (
			!opened.isFile() ||
			opened.dev !== before.dev ||
			opened.ino !== before.ino ||
			!inside(realpathSync(abs))
		) {
			return null
		}
		// Snapshot the byte ceiling, not the file's contents: later growth cannot extend the read.
		const scanLimit = Math.min(opened.size, MAX_SCAN_BYTES, budget.bytes)
		let remaining = scanLimit
		let eof = false
		if (remaining <= 0 && opened.size > 0) return null
		const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, remaining))
		const decoder = new StringDecoder('utf8')
		let line = 1
		let content = ''
		let done = false
		const consume = (chunk: string): void => {
			for (const char of chunk) {
				if (range && line > range.end) {
					done = true
					break
				}
				if (!range || line >= range.start) {
					// The newline after the last selected line is not part of the range.
					if (!(range && line === range.end && char === '\n')) content += char
					if (content.length > maxChars) {
						done = true
						break
					}
				}
				if (char === '\n') line++
			}
		}
		while (remaining > 0 && !done) {
			const count = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null)
			if (count === 0) {
				eof = true
				break
			}
			remaining -= count
			budget.bytes -= count
			consume(decoder.write(buffer.subarray(0, count)))
		}
		if (!done) consume(decoder.end())
		if (range && line < range.start) return null
		const rangeComplete = range !== undefined && line > range.end
		const truncated =
			content.length > maxChars || (!eof && !rangeComplete && scanLimit < opened.size)
		return truncated ? `${content.slice(0, maxChars)}\n… (truncated)` : content
	} catch {
		return null
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd)
			} catch {
				// A failed path must not stop message submission.
			}
		}
	}
}
