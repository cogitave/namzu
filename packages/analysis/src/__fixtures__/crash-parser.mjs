// A stand-in for oxc-parser that kills its process on any source holding the marker, every time, and
// parses everything else with oxc-parser itself.
import { parseSync as oxcParseSync } from 'oxc-parser'

export const CRASH_MARKER = 'kill-the-parsing-child'

export function rawTransferSupported() {
	return false
}

export function parseSync(path, text, options) {
	if (text.includes(CRASH_MARKER)) process.abort()
	return oxcParseSync(path, text, options)
}
