/**
 * Theme tokens for the TUI — a single dark palette. We inherit the
 * terminal's own background (like claude-code / gemini-cli) rather than
 * painting one, and only theme the foreground; curated hex colors
 * (GitHub-dark-leaning) give a consistent, premium look on dark terminals.
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
	background: '#000000',
	text: {
		primary: '#e6edf3',
		secondary: '#8b949e',
		muted: '#56606b',
	},
	accent: {
		user: '#56d4dd',
		assistant: '#7ee787',
		system: '#e3b341',
		tool: '#bc8cff',
	},
	status: {
		ok: '#7ee787',
		warn: '#e3b341',
		error: '#ff7b72',
	},
	border: {
		default: '#30363d',
		focus: '#56d4dd',
	},
}
