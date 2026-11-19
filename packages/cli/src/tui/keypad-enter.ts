/**
 * Make the Enter key on the number pad do what the main Enter key does.
 *
 * The terminal is asked for the enhanced keyboard reporting (see `index.tsx`). A terminal that
 * answers it sends the number pad's Enter as its own key, `ESC [ 57414 u`, not as a carriage
 * return, and the screen reads only a carriage return as "Enter": the right-hand Enter then
 * confirmed nothing (not a message, not a choice on a card). The key is the same key with
 * another code, so it is rewritten to the main Enter's code before the screen reads it:
 * `ESC [ 57414 ; 5 u` (with Ctrl) becomes `ESC [ 13 ; 5 u`, so every modifier keeps meaning
 * what it means on the main key. The older number-pad form some terminals send (`ESC O M`)
 * becomes a carriage return.
 */

const ESC = '\u001b'
const KEYPAD_ENTER_CODEPOINT = new RegExp(`${ESC}\\[57414(?=[;:u])`, 'g')

/** The bytes with the number pad's Enter written as the main Enter. */
export function rewriteKeypadEnter(text: string): string {
	if (!text.includes(ESC)) return text
	return text.replaceAll(KEYPAD_ENTER_CODEPOINT, `${ESC}[13`).replaceAll(`${ESC}OM`, '\r')
}

interface RewrittenInput {
	read: (...args: never[]) => unknown
}

/** Wrap `stdin.read` so the number pad's Enter reaches the reader as Enter. Returns the undo. */
export function installKeypadEnter(stdin: RewrittenInput): () => void {
	const originalRead = stdin.read
	stdin.read = function patchedRead(this: unknown, ...args: never[]): unknown {
		const chunk = originalRead.apply(this, args)
		return typeof chunk === 'string' ? rewriteKeypadEnter(chunk) : chunk
	}
	let removed = false
	return () => {
		if (removed) return
		removed = true
		stdin.read = originalRead
	}
}
