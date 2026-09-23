/**
 * Quoting for each supervisor's file format. Paths are data; each format's
 * special characters are escaped, never interpreted.
 */

/** A word in a systemd unit's `ExecStart=`: double-quoted, `%` and `$` doubled. */
export function systemdWord(text: string): string {
	const escaped = text
		.replaceAll('\\', '\\\\')
		.replaceAll('"', '\\"')
		.replaceAll('%', '%%')
		.replaceAll('$', '$$$$')
	return `"${escaped}"`
}

/** A value in a systemd `Environment=` assignment, quoted as a whole. */
export function systemdAssignment(key: string, value: string): string {
	return systemdWord(`${key}=${value}`)
}

/** Text in XML content or an attribute. */
export function xmlText(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;')
}

/**
 * A Windows command-line argument, quoted by the rules `CommandLineToArgvW`
 * applies: backslashes before a quote are doubled, quotes are escaped.
 */
export function windowsArgument(text: string): string {
	if (text !== '' && !/[\s"]/.test(text)) return text
	let out = '"'
	let slashes = 0
	for (const ch of text) {
		if (ch === '\\') {
			slashes++
			continue
		}
		if (ch === '"') {
			out += `${'\\'.repeat(slashes * 2 + 1)}"`
		} else {
			out += '\\'.repeat(slashes) + ch
		}
		slashes = 0
	}
	return `${out}${'\\'.repeat(slashes * 2)}"`
}

/**
 * A path `wsl.exe` passes on unchanged. Its command line is re-parsed on the
 * Linux side, so a space, `$`, a quote or a backtick would split or change
 * it; rather than an escape layer that has to be right twice, such a path is
 * refused.
 */
export const WSL_SAFE_PATH = /^[A-Za-z0-9._/@+-]+$/

export function checkWslPath(label: string, path: string): string {
	if (!WSL_SAFE_PATH.test(path)) {
		throw new Error(
			`${label} ${path} contains characters wsl.exe would re-read (only letters, digits and . _ / @ + - are passed through safely); install node and namzu under a plain path, or use --platform systemd-user`,
		)
	}
	return path
}
