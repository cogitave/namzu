/**
 * Which terminal this is, from what it puts in the environment. Only what
 * `/terminal-setup` and its hint need: the terminals Namzu can set up, the ones
 * that need nothing, and the rest.
 */

export type TerminalId =
	| 'vscode'
	| 'cursor'
	| 'windsurf'
	| 'alacritty'
	| 'zed'
	| 'apple'
	| 'iterm2'
	| 'ghostty'
	| 'kitty'
	| 'wezterm'
	| 'warp'
	| 'windows-terminal'
	| 'tmux'
	| 'other'

type Env = Readonly<Record<string, string | undefined>>

export const TERMINAL_NAMES: Readonly<Record<TerminalId, string>> = {
	vscode: 'VS Code',
	cursor: 'Cursor',
	windsurf: 'Windsurf',
	alacritty: 'Alacritty',
	zed: 'Zed',
	apple: 'Terminal.app',
	iterm2: 'iTerm2',
	ghostty: 'Ghostty',
	kitty: 'Kitty',
	wezterm: 'WezTerm',
	warp: 'Warp',
	'windows-terminal': 'Windows Terminal',
	tmux: 'tmux',
	other: 'your current terminal',
}

/** Terminals that send Shift+Enter in a form Namzu reads without any setting. */
export const NATIVE_TERMINALS: readonly TerminalId[] = [
	'iterm2',
	'ghostty',
	'kitty',
	'wezterm',
	'warp',
	'windows-terminal',
]

/** The editors that carry a terminal and keep their settings in a user folder. */
export const EDITOR_TERMINALS: readonly TerminalId[] = ['vscode', 'cursor', 'windsurf']

const has = (value: string | undefined): boolean => value !== undefined && value !== ''

export function identifyTerminal(env: Env): TerminalId {
	const program = env.TERM_PROGRAM
	const bundle = (env.__CFBundleIdentifier ?? '').toLowerCase()
	if (program === 'tmux') return 'tmux'
	if (program === 'vscode') {
		if (has(env.CURSOR_TRACE_ID) || bundle.includes('cursor')) return 'cursor'
		if (bundle.includes('windsurf') || bundle.includes('devin')) return 'windsurf'
		return 'vscode'
	}
	if (program === 'zed' || bundle.includes('dev.zed')) return 'zed'
	if (program === 'Apple_Terminal') return 'apple'
	if (program === 'iTerm.app' || has(env.ITERM_SESSION_ID)) return 'iterm2'
	if (program === 'ghostty' || has(env.GHOSTTY_RESOURCES_DIR)) return 'ghostty'
	if (program === 'WezTerm' || has(env.WEZTERM_EXECUTABLE)) return 'wezterm'
	if (program === 'WarpTerminal') return 'warp'
	if (has(env.KITTY_WINDOW_ID) || env.TERM === 'xterm-kitty') return 'kitty'
	if (has(env.WT_SESSION)) return 'windows-terminal'
	if (env.TERM === 'alacritty' || has(env.ALACRITTY_LOG) || has(env.ALACRITTY_SOCKET))
		return 'alacritty'
	return 'other'
}

/** Terminals `/terminal-setup` can write a setting for. */
export function canSetUp(id: TerminalId, platform: string): boolean {
	if (id === 'apple') return platform === 'darwin'
	return (
		id === 'vscode' || id === 'cursor' || id === 'windsurf' || id === 'alacritty' || id === 'zed'
	)
}

/** An editor's own terminal reached through its remote server: its settings are not on this machine. */
export function isRemoteEditorSession(env: Env): boolean {
	const text = `${env.PATH ?? ''}:${env.VSCODE_GIT_ASKPASS_MAIN ?? ''}`
	return ['.vscode-server', '.cursor-server', '.windsurf-server', '.devin-server'].some((m) =>
		text.includes(m),
	)
}
