/**
 * The key that puts the spaces host in navigate mode.
 *
 * It must be one control byte the host can see before the child does, so it is
 * written `ctrl+<letter>` or `ctrl+space`. Keys that a terminal program needs for
 * itself (interrupt, end of input, suspend) or that are the same byte as Tab,
 * Enter, Backspace or Escape cannot be the prefix.
 */
export interface Prefix {
	/** The setting as written, normalised: `ctrl+b`, `ctrl+space`. */
	readonly name: string
	/** The single byte the terminal sends for it. */
	readonly byte: string
}

export const DEFAULT_PREFIX: Prefix = { name: 'ctrl+b', byte: '\x02' }

/** Letters whose control byte is something else the child needs. */
const RESERVED = new Set(['c', 'd', 'z', 'h', 'i', 'j', 'm', 'q', 's', '['])

export function parsePrefix(value: string): Prefix | undefined {
	const text = value.trim().toLowerCase().replaceAll(' ', '')
	if (text === 'ctrl+space') return { name: 'ctrl+space', byte: '\x00' }
	const match = /^ctrl\+([a-z])$/u.exec(text)
	if (!match) return undefined
	const letter = match[1] as string
	if (RESERVED.has(letter)) return undefined
	return {
		name: `ctrl+${letter}`,
		byte: String.fromCharCode(letter.charCodeAt(0) - 96),
	}
}

/** The words shown for a prefix, for example `ctrl+b`. */
export function describePrefix(prefix: Prefix): string {
	return prefix.name
}
