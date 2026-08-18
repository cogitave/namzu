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

export function writeClipboardText(
	text: string,
	output: TerminalClipboardOutput,
): ClipboardWriteResult {
	if (!output.isTTY) {
		return { kind: 'unavailable', detail: 'stdout is not an interactive terminal' }
	}

	const bytes = Buffer.byteLength(text, 'utf8')
	if (bytes > MAX_CLIPBOARD_TEXT_BYTES) {
		return { kind: 'too-large', bytes, limit: MAX_CLIPBOARD_TEXT_BYTES }
	}

	try {
		const encoded = Buffer.from(text, 'utf8').toString('base64')
		// `c` selects the clipboard; BEL terminates the OSC control sequence.
		output.write(`\x1b]52;c;${encoded}\x07`)
		return { kind: 'request-sent', bytes }
	} catch (err) {
		return {
			kind: 'write-failed',
			detail: err instanceof Error ? err.message : String(err),
		}
	}
}
