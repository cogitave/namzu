/**
 * Theme tokens for the TUI — a single, fully-dark palette tuned for a
 * black canvas (the root fills with `background` and the screen is cleared
 * on launch). Curated hex colors (GitHub-dark-leaning) give a consistent,
 * premium look across terminals rather than depending on the user's 16
 * ANSI colors. A theme registry/picker is a follow-up.
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
