/**
 * Minimal theme tokens for the M3 TUI.
 *
 * Single theme (dark-terminal-friendly) for M3. A `ThemeProvider` + picker
 * is a follow-up — gemini-cli ships 1 theme + lets users pick; opencode
 * ships 35. We start with one and add a registry when there's a second.
 */

export interface SemanticColors {
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
	text: {
		primary: 'white',
		secondary: 'gray',
		muted: 'blackBright',
	},
	accent: {
		user: 'cyan',
		assistant: 'green',
		system: 'yellow',
		tool: 'magenta',
	},
	status: {
		ok: 'green',
		warn: 'yellow',
		error: 'red',
	},
	border: {
		default: 'gray',
		focus: 'cyan',
	},
}
