/**
 * Theme tokens for the TUI — warm chalk, copper and quiet mineral tones. We inherit the
 * terminal's own background rather than painting one, and only theme the
 * foreground — a TUI that repaints the canvas fights whatever the user
 * already chose. Foregrounds sit on the ANSI 256-color palette so reduced
 * color terminals retain neutral text instead of rounding it into a hue.
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
	}
	readonly status: {
		readonly ok: string
		readonly warn: string
		readonly error: string
	}
	readonly border: {
		readonly default: string
		readonly focus: string
	}
}

export const theme: SemanticColors = {
	background: '#181816',
	text: {
		primary: '#e4e4e4',
		secondary: '#b2b2b2',
		muted: '#8a8a8a',
	},
	accent: {
		user: '#d7af87',
		assistant: '#d7af87',
		system: '#afaf87',
		tool: '#afafaf',
	},
	status: {
		ok: '#87af87',
		warn: '#d7af5f',
		error: '#d78787',
	},
	border: {
		default: '#585858',
		focus: '#d7af87',
	},
}
