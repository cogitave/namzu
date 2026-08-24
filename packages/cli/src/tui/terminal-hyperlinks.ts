/** Conservative OSC 8 admission for terminal-rendered web links. */

const OSC = '\u001b]'
const ST = '\u001b\\'
const MAX_TARGET_BYTES = 4_096

export type TerminalEnvironment = Readonly<Record<string, string | undefined>>

/**
 * Whether the current output path is known to understand terminal hyperlinks.
 *
 * OSC 8 has no portable capability query or acknowledgement. Unknown terminals
 * therefore keep the URL visible as plain text. Multiplexers and remote shells
 * are also conservative: either can filter the sequence between this process
 * and the terminal that owns the clipboard/click target.
 */
export function terminalSupportsHyperlinks(env: TerminalEnvironment, isTTY: boolean): boolean {
	if (!isTTY) return false
	if (env.TMUX || env.STY || env.SSH_TTY || env.SSH_CONNECTION) return false

	const term = env.TERM?.toLowerCase() ?? ''
	if (term === 'dumb' || term.startsWith('screen') || term.startsWith('tmux')) return false

	const termProgram = env.TERM_PROGRAM?.toLowerCase() ?? ''
	if (['iterm.app', 'wezterm', 'vscode', 'ghostty'].includes(termProgram)) return true
	if (
		env.WT_SESSION ||
		env.KITTY_WINDOW_ID ||
		env.KONSOLE_VERSION ||
		env.VTE_VERSION ||
		env.ALACRITTY_SOCKET ||
		env.GHOSTTY_RESOURCES_DIR
	) {
		return true
	}

	return term === 'xterm-kitty' || term.includes('wezterm') || term.includes('alacritty')
}

/**
 * Wrap a visible label in an OSC 8 web hyperlink.
 *
 * Only absolute HTTP(S) URLs are admitted. The URL serializer produces the
 * terminal-bound value, so Unicode and spaces are percent-encoded and raw
 * control/bidi characters can never acquire terminal authority.
 */
export function terminalWebHyperlink(label: string, rawTarget: string): string | null {
	if (containsTerminalControl(rawTarget)) return null

	let url: URL
	try {
		url = new URL(rawTarget)
	} catch {
		return null
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null

	const target = url.href
	if (Buffer.byteLength(target, 'utf8') > MAX_TARGET_BYTES) return null
	return `${OSC}8;;${target}${ST}${label}${OSC}8;;${ST}`
}

function containsTerminalControl(value: string): boolean {
	for (const char of value) {
		const code = char.codePointAt(0) ?? 0
		if (
			code <= 0x1f ||
			(code >= 0x7f && code <= 0x9f) ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069)
		) {
			return true
		}
	}
	return false
}
