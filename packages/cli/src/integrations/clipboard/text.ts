/**
 * Ask an interactive terminal to place text on its clipboard via OSC 52.
 *
 * This deliberately does not spawn a platform clipboard command. `/copy` is a
 * TUI operation, not permission to run arbitrary host code outside the agent's
 * sandbox and approval path. The escape payload is base64, so model-authored
 * control characters cannot terminate the sequence and inject another one.
 *
 * OSC 52 has no portable acknowledgement. A successful write proves only that
 * the complete request reached Ink's stdout; a terminal, multiplexer or remote
 * hop may still ignore it. The result therefore says `request-sent`, never
 * `copied`, and the caller must preserve that distinction in its message.
 */

/**
 * Bound the raw UTF-8 text before base64 expands it by roughly one third.
 *
 * Terminal limits vary and cannot be negotiated. Refusing above a stated cap
 * is honest; truncating would put something on the clipboard that is not the
 * answer the operator asked for.
 */
export const MAX_CLIPBOARD_TEXT_BYTES = 100_000

export interface TerminalClipboardOutput {
	/** Whether Ink is attached to an interactive terminal. */
	readonly isTTY?: boolean
	/** Ink's stdout writer, which preserves the frame around out-of-band output. */
	readonly write: (data: string) => void
}

export type ClipboardWriteResult =
	| { readonly kind: 'request-sent'; readonly bytes: number }
	| { readonly kind: 'unavailable'; readonly detail: string }
	| { readonly kind: 'too-large'; readonly bytes: number; readonly limit: number }
	| { readonly kind: 'write-failed'; readonly detail: string }

/** The slice of the environment that decides how the request must be wrapped to reach the terminal. */
export interface ClipboardEnv {
	readonly TMUX?: string | undefined
	readonly STY?: string | undefined
	readonly TERM?: string | undefined
}

/** Longest base64 piece one screen passthrough frame carries. */
const SCREEN_CHUNK = 76

/**
 * The bytes that ask the terminal to put `text` on its clipboard.
 *
 * Inside tmux the request is wrapped in a passthrough frame (every ESC doubled),
 * which tmux forwards only when its `allow-passthrough` option is on. Inside
 * screen it is cut into passthrough frames of at most 76 base64 characters. The
 * plain form is used everywhere else.
 */
export function buildClipboardSequence(text: string, env: ClipboardEnv = process.env): string {
	const encoded = Buffer.from(text, 'utf8').toString('base64')
	// `c` selects the clipboard; BEL terminates the OSC control sequence.
	const plain = `\x1b]52;c;${encoded}\x07`
	if (env.TMUX) return `\x1bPtmux;${plain.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`
	if (env.STY || env.TERM?.startsWith('screen')) {
		let frames = ''
		for (let at = 0; at < encoded.length || at === 0; at += SCREEN_CHUNK)
			frames += `\x1bP\x1b]52;c;${encoded.slice(at, at + SCREEN_CHUNK)}\x07\x1b\\`
		return frames
	}
	return plain
}

export function writeClipboardText(
	text: string,
	output: TerminalClipboardOutput,
	env: ClipboardEnv = process.env,
): ClipboardWriteResult {
	if (!output.isTTY) {
		return { kind: 'unavailable', detail: 'stdout is not an interactive terminal' }
	}

	const bytes = Buffer.byteLength(text, 'utf8')
	if (bytes > MAX_CLIPBOARD_TEXT_BYTES) {
		return { kind: 'too-large', bytes, limit: MAX_CLIPBOARD_TEXT_BYTES }
	}

	try {
		output.write(buildClipboardSequence(text, env))
		return { kind: 'request-sent', bytes }
	} catch (err) {
		return {
			kind: 'write-failed',
			detail: err instanceof Error ? err.message : String(err),
		}
	}
}
