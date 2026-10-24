/**
 * Theme tokens for the TUI — phosphor green, neutral text and quiet graphite. We inherit the
 * terminal's own background rather than painting one, and only theme the
 * foreground. Explicit ANSI indices avoid Chalk's RGB cube approximation,
 * which can turn an intended palette color into a different hue.
 * `background` is kept for reference / a future light theme but is not
 * forced onto the canvas. A theme registry/picker is a follow-up.
 */

export interface SemanticColors {
	/** Canvas background — the whole UI sits on this. */
	readonly background: string
	readonly text: {
		readonly primary: string
		readonly secondary: string
		readonly muted: string
	}
	readonly accent: {
		readonly user: string
		readonly assistant: string
		readonly system: string
		readonly tool: string
		/**
		 * The hypermode session mode's own colour (violet), used wherever the
		 * mode is named: the effort slider's last stop and the composer tag.
		 * Never a status colour.
		 */
		readonly hypermode: string
		/**
		 * An armed composer trigger (sky): its words in the draft and its tag
		 * row. Kept apart from the session mode's violet, which names what lasts
		 * for the session; a trigger lasts one message.
		 */
		readonly trigger: string
		/** Plan mode in the footer's mode item (teal). */
		readonly plan: string
		/** Background shells in the footer pill (cyan). */
		readonly shells: string
	}
	readonly status: {
		readonly ok: string
		readonly warn: string
		readonly error: string
		/** A merged pull request (purple). */
		readonly merged: string
	}
	readonly border: {
		readonly default: string
		readonly focus: string
	}
}

export const theme: SemanticColors = {
	background: '#0b0f0c',
	text: {
		primary: 'ansi256(252)',
		secondary: 'ansi256(248)',
		muted: 'ansi256(245)',
	},
	accent: {
		user: 'ansi256(83)',
		assistant: 'ansi256(83)',
		system: 'ansi256(109)',
		tool: 'ansi256(248)',
		hypermode: 'ansi256(141)',
		trigger: 'ansi256(117)',
		plan: 'ansi256(73)',
		shells: 'ansi256(37)',
	},
	status: {
		ok: 'ansi256(77)',
		warn: 'ansi256(221)',
		error: 'ansi256(203)',
		merged: 'ansi256(135)',
	},
	border: {
		default: 'ansi256(239)',
		focus: 'ansi256(83)',
	},
}

/**
 * The backgrounds a diff row is drawn on. Six tokens: a whole added or removed row, the same dimmed
 * for a change that was
 * refused, and the words that differ inside a changed pair of rows.
 */
export interface DiffColors {
	readonly added: string
	readonly removed: string
	readonly addedDimmed: string
	readonly removedDimmed: string
	readonly addedWord: string
	readonly removedWord: string
}

/** For a terminal that reports 24-bit colour: the dark-theme values. */
export const DIFF_COLORS_TRUECOLOR: DiffColors = {
	added: 'rgb(34,92,43)',
	removed: 'rgb(122,41,54)',
	addedDimmed: 'rgb(71,88,74)',
	removedDimmed: 'rgb(105,72,77)',
	addedWord: 'rgb(56,166,96)',
	removedWord: 'rgb(179,89,107)',
}

/** For every other terminal: the named ANSI colours, words in the bright variant. */
export const DIFF_COLORS_ANSI: DiffColors = {
	added: 'green',
	removed: 'red',
	addedDimmed: 'green',
	removedDimmed: 'red',
	addedWord: 'greenBright',
	removedWord: 'redBright',
}

const TRUECOLOR_PROGRAMS = new Set(['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper'])

/** Whether the terminal says it draws 24-bit colour. */
export function reportsTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	const colorterm = env.COLORTERM?.toLowerCase()
	if (colorterm === 'truecolor' || colorterm === '24bit') return true
	if (env.WT_SESSION !== undefined) return true
	if (env.TERM_PROGRAM !== undefined && TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM)) return true
	return /direct|truecolor|24bit/i.test(env.TERM ?? '')
}

/** The diff colours this terminal can draw. */
export function diffColors(env: NodeJS.ProcessEnv = process.env): DiffColors {
	return reportsTruecolor(env) ? DIFF_COLORS_TRUECOLOR : DIFF_COLORS_ANSI
}
