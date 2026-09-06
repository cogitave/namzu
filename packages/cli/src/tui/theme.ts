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
	},
	status: {
		ok: 'ansi256(77)',
		warn: 'ansi256(221)',
		error: 'ansi256(203)',
	},
	border: {
		default: 'ansi256(239)',
		focus: 'ansi256(83)',
	},
}
