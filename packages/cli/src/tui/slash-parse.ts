/** Reading one typed slash line, with no screen code behind it. */

export interface ParsedSlash {
	readonly name: string
	readonly args: readonly string[]
}

/**
 * Commands spelled as keywords: the command is the first word and the second
 * word picks what it does, so `/add dir` is the command `add dir`.
 */
export const KEYWORD_COMMANDS: readonly { readonly first: string; readonly second: string }[] = [
	{ first: 'add', second: 'dir' },
	{ first: 'release', second: 'notes' },
	{ first: 'terminal', second: 'setup' },
]

/** Returns null when the line is not a slash command. */
export function parseSlash(line: string): ParsedSlash | null {
	const trimmed = line.trim()
	if (!trimmed.startsWith('/')) return null
	const [word, ...rest] = trimmed.slice(1).split(/\s+/)
	if (!word) return null
	for (const { first, second } of KEYWORD_COMMANDS) {
		if (word === first && rest[0] === second) {
			return { name: `${first} ${second}`, args: rest.slice(1) }
		}
	}
	return { name: word, args: rest }
}
