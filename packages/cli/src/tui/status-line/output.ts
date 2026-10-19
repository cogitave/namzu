/**
 * What a status line command printed, made ready for the footer.
 *
 * The reference trims the whole output, trims every line and drops the blank
 * ones, so a script's stray blank line costs no row. Colours stay. Namzu
 * additionally drops every other escape sequence and control character: the
 * line is drawn inside a laid-out screen, and a cursor move or a clear from a
 * script would draw over the composer. Colours (`ESC [ … m`) and OSC 8 links
 * are the only sequences kept.
 */

// Built from strings: the lint rule against control characters in a regex
// literal is right about almost every regex and wrong about a filter for them.
const ESC = '\\x1b'
const BEL = '\\x07'
const KEPT = new RegExp(`${ESC}\\[[\\d;]*m|${ESC}\\]8;[^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'gu')
/** Private-use marker standing in for a kept sequence while the rest is filtered. */
const HOLD = '\uE000'
/** Any escape sequence the screen cannot carry, then the remaining control characters. */
const STRIPPED = new RegExp(
	[
		`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
		`${ESC}\\[[\\d;?]*[ -/]*[@-~]`,
		`${ESC}[@-_]`,
		'[\\x00-\\x08\\x0b-\\x1a\\x1c-\\x1f\\x7f]',
	].join('|'),
	'gu',
)

export function sanitiseStatusLineOutput(stdout: string): string | undefined {
	const kept: string[] = []
	const text = stdout.replace(/\r\n?/gu, '\n').replace(KEPT, (m) => {
		kept.push(m)
		return `${HOLD}${kept.length - 1}${HOLD}`
	})
	const cleaned = text
		.replace(STRIPPED, '')
		.replace(
			new RegExp(`${HOLD}(\\d+)${HOLD}`, 'gu'),
			(_m, index: string) => kept[Number(index)] ?? '',
		)
	const lines = cleaned
		.trim()
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	return lines.length > 0 ? lines.join('\n') : undefined
}

/**
 * One entry per line, each prefixed with the colour state the lines before it
 * left open, so a colour started on line one still applies on line two when
 * each line is drawn on its own row (the reference's `OKe`).
 */
export function carryStyleAcrossLines(text: string): string[] {
	const lines = text.split('\n')
	if (lines.length === 1) return lines
	const out = [lines[0] ?? '']
	let carried = ''
	for (let index = 1; index < lines.length; index++) {
		carried += (lines[index - 1]?.match(KEPT) ?? []).join('')
		out.push(carried + (lines[index] ?? ''))
	}
	return out
}
