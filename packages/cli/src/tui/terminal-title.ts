/**
 * The terminal's own title, so a tab or window says what the conversation is.
 *
 * Written as OSC 0, which sets both the window title and the icon name. The
 * text is the conversation's name when a person gave it one, else the title
 * the small model wrote, else the product name; a glyph before it shows
 * whether a turn is running. The title is reset when the interface closes, so
 * the shell's own title comes back.
 *
 * `NAMZU_DISABLE_TERMINAL_TITLE` turns every write off. Nothing is written to
 * a stream that is not a terminal.
 */

/** What the title says before a conversation has a name. */
export const DEFAULT_TERMINAL_TITLE = 'Namzu'
/** Before the title while the interface waits for input. */
export const IDLE_TITLE_GLYPH = '✳'
/** Before the title while a turn runs. */
export const BUSY_TITLE_GLYPH = '◐'
/** Longest name put in a title. */
const TITLE_NAME_MAX = 100

const OSC_SET_TITLE_AND_ICON = '\u001b]0;'
const BEL = '\u0007'

/** Control characters would end the sequence early or move the cursor. */
function printable(text: string): string {
	return (
		text
			// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
			.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, ' ')
			.replace(/\s+/gu, ' ')
			.trim()
	)
}

export interface TerminalTitleInput {
	/** The name a person gave the conversation. */
	readonly named?: string | undefined
	/** The title the small model wrote. */
	readonly generated?: string | undefined
	/** A turn is running. */
	readonly busy: boolean
}

/** The title text for the current state: name, else generated title, else the product name. */
export function terminalTitleText(input: TerminalTitleInput): string {
	const name = [input.named, input.generated, DEFAULT_TERMINAL_TITLE]
		.map((candidate) => printable(candidate ?? ''))
		.find((candidate) => candidate.length > 0) as string
	const shown = name.length > TITLE_NAME_MAX ? `${name.slice(0, TITLE_NAME_MAX - 1)}…` : name
	return `${input.busy ? BUSY_TITLE_GLYPH : IDLE_TITLE_GLYPH} ${shown}`
}

export function setTerminalTitleSequence(text: string): string {
	return `${OSC_SET_TITLE_AND_ICON}${printable(text)}${BEL}`
}

/** An empty title: the terminal goes back to its own. */
export const RESET_TERMINAL_TITLE_SEQUENCE = `${OSC_SET_TITLE_AND_ICON}${BEL}`

export function terminalTitleEnabled(
	env: Readonly<Record<string, string | undefined>>,
	isTTY: boolean | undefined,
): boolean {
	if (isTTY !== true) return false
	const off = env.NAMZU_DISABLE_TERMINAL_TITLE
	return off === undefined || off === '' || off === '0' || off.toLowerCase() === 'false'
}
