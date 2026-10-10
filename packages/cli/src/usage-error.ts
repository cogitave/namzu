/**
 * How a command-line mistake reads.
 *
 * Commander writes `error: option '--effort <level>' argument 'turbo' is
 * invalid. Allowed choices are none, minimal, low…` as one unbroken line. That
 * is a log line, not a sentence for a person: it starts in lower case, carries
 * no full stop when the cause is short, and runs past the edge of the terminal.
 * This turns it into sentences in sentence case, wrapped at word boundaries,
 * and points at `--help` once. The exit code is not decided here.
 */

const HELP_POINTER = 'Run namzu --help to see what is available.'

/** Wrap one line at spaces to `width` columns. A word longer than the width keeps its own row. */
export function wrapAtWords(line: string, width: number): string[] {
	if (width < 20 || line.length <= width) return [line]
	const rows: string[] = []
	const indent = /^\s*/.exec(line)?.[0] ?? ''
	let current = ''
	for (const word of line.trim().split(/\s+/)) {
		if (current.length === 0) current = `${indent}${word}`
		else if (current.length + 1 + word.length <= width) current += ` ${word}`
		else {
			rows.push(current)
			current = `${indent}${word}`
		}
	}
	if (current.length > 0) rows.push(current)
	return rows
}

/** The long flag out of commander's `-f, --format <type>` spelling. */
function flagName(spelled: string): string {
	return /--[\w-]+/.exec(spelled)?.[0] ?? spelled.split(/[ ,]/)[0] ?? spelled
}

/** Commander's own sentence for the mistakes people make most, in plainer words. */
function plainer(first: string): string {
	const invalid =
		/^option '([^']+)' argument '(.*)' is invalid\.(?: Allowed choices are (.+)\.)?$/.exec(first)
	if (invalid) {
		const choices = invalid[3] ? ` Choose one of ${invalid[3]}.` : ''
		return `“${invalid[2]}” is not a valid value for ${flagName(invalid[1] ?? '')}.${choices}`
	}
	const missing = /^option '([^']+)' argument missing$/.exec(first)
	if (missing) return `${flagName(missing[1] ?? '')} needs a value.`
	return first
}

/** Commander's complaint as sentences, wrapped, with the way forward on its own line. */
export function formatUsageError(text: string, columns: number | undefined): string {
	const width = Math.min(Math.max(columns ?? 80, 20), 100)
	const lines = text
		.trim()
		.split('\n')
		.map((line, index) => {
			let sentence = index === 0 ? plainer(line.replace(/^error:\s*/i, '')) : line
			if (index === 0 && /^[a-z]/.test(sentence)) {
				sentence = `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`
			}
			if (index === 0 && !/[.!?:]$/.test(sentence)) sentence = `${sentence}.`
			return sentence
		})
	// A message that already says where to go (`--help`, or a second line naming the
	// right command) is not given a second pointer.
	const points = lines.length > 1 || /\bhelp\b/i.test(text)
	const body = (points ? lines : [...lines, HELP_POINTER]).flatMap((line) =>
		wrapAtWords(line, width),
	)
	return `${body.join('\n')}\n`
}
