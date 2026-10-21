import { type Parsed, languageOf, parseSource } from './parse.js'
import { scanTolerantly } from './scan.js'
import { RowSink, type RowsPayload, indexProgram } from './walk.js'

/**
 * How a file that does not parse is still read.
 *
 * `0` is a file the parser took (clean, or with an error it recovered from and
 * a tree it kept). `1` is a file read after its broken lines were blanked out.
 * `2` is a file only the tolerant scanner could read. See {@link parseRecovering}.
 */
export type Degraded = 0 | 1 | 2

export interface Recovered {
	readonly rows: RowsPayload
	readonly errors: number
	readonly degraded: Degraded
}

/** Passes of blank-and-reparse before giving up on the parser. */
const MAX_REPAIRS = 12
/** Past this share of the text blanked, what is left is not worth trusting. */
const MAX_BLANKED_SHARE = 0.5

/** `text` with the whole lines holding `starts` replaced by spaces; offsets and newlines unchanged. */
function blankLines(text: string, starts: readonly number[], blanked: Set<number>): string {
	const chars = text.split('')
	for (const at of new Set(starts)) {
		let from = Math.min(Math.max(at, 0), text.length - 1)
		while (from > 0 && text[from - 1] !== '\n') from--
		if (blanked.has(from)) continue
		blanked.add(from)
		let to = from
		while (to < text.length && text[to] !== '\n') {
			if (text[to] !== '\r') chars[to] = ' '
			to++
		}
	}
	return chars.join('')
}

function rowsOf(parsed: Parsed): RowsPayload {
	const sink = new RowSink(0)
	indexProgram(parsed.program as Parameters<typeof indexProgram>[0], sink)
	return sink
}

/**
 * Parse `text`, and when the parser gives up, still get what can be had.
 *
 * `oxc-parser` returns a recovered tree for some errors (a stray `return`, an
 * early `await`) and an EMPTY program for others, and an empty program is the
 * whole file lost. In that case, in order:
 *
 * 1. **As TypeScript.** A `.js` file with `a: string` annotations is Flow or a
 *    TS-in-JS file; the `// @flow` pragma, which the parser refuses outright,
 *    is blanked for the attempt.
 * 2. **Blank the broken lines and parse again**, up to {@link MAX_REPAIRS}
 *    times and while less than half the text is blanked. The blanked text has
 *    the same length and line breaks, so every offset is still an offset into
 *    the real file. This is what keeps `function ok1()` and `function ok2()`
 *    on either side of one bad statement.
 * 3. **The tolerant scanner** ({@link scanTolerantly}): strings and
 *    `function name(` anchors, nothing more.
 *
 * `errors` is the count from the parse of the text as written, so a file read
 * after blanking its broken lines or by the scanner is reported as having had
 * syntax errors. A file that parsed cleanly on the TypeScript retry (Flow
 * annotations) has none.
 */
export async function parseRecovering(path: string, text: string): Promise<Recovered> {
	const first = await parseSource(path, text)
	if (first.errors === 0 || !first.empty) {
		return { rows: rowsOf(first), errors: first.errors, degraded: 0 }
	}

	const lang = languageOf(path)
	const flow = /(^|\n)[ \t]*\/[/*]\s*@flow\b/.exec(text)
	const unflowed = flow
		? text.slice(0, flow.index) + text.slice(flow.index).replace('@flow', '     ')
		: text
	let current = text
	let best: Parsed = first

	if (lang === 'jsx' || lang === 'js' || lang === undefined) {
		const asTs = await parseSource(path, unflowed, 'tsx')
		if (asTs.errors === 0 || !asTs.empty) {
			// A clean parse as TypeScript is a file that parsed: Flow annotations are
			// not syntax errors, and the file is not reported as having had any.
			if (asTs.errors === 0) return { rows: rowsOf(asTs), errors: 0, degraded: 0 }
			return { rows: rowsOf(asTs), errors: first.errors, degraded: 1 }
		}
		if (flow) {
			current = unflowed
			best = asTs
		}
	}

	const reparseAs = flow ? 'tsx' : lang === 'jsx' || lang === undefined ? undefined : lang
	const blanked = new Set<number>()
	let working = current
	let parsed = best
	for (let pass = 0; pass < MAX_REPAIRS && parsed.errorStarts.length > 0; pass++) {
		const before = blanked.size
		working = blankLines(working, parsed.errorStarts, blanked)
		if (blanked.size === before) break
		let share = 0
		for (let k = 0; k < working.length; k++) if (working[k] === ' ' && text[k] !== ' ') share++
		if (share > working.length * MAX_BLANKED_SHARE) break
		parsed = await parseSource(path, working, reparseAs)
		if (parsed.errors === 0 || !parsed.empty) {
			if (parsed.empty) break
			return { rows: rowsOf(parsed), errors: first.errors, degraded: 1 }
		}
	}

	const sink = new RowSink(0)
	scanTolerantly(text, sink)
	return { rows: sink, errors: first.errors, degraded: 2 }
}
