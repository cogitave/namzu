/**
 * How much of a streaming reply is ready to be shown.
 *
 * ## Why anything is held back at all
 *
 * The kernel emits a reply as token deltas, and the transcript used to append
 * every one of them the moment it arrived. Nothing animated it — there is no
 * timer and no per-character reveal anywhere in this package — but appending a
 * few characters at a time produces the same thing on screen: text that types
 * itself out. An operator reading it watches a line grow instead of reading a
 * line.
 *
 * So deltas accumulate and are released a **block** at a time: a paragraph, a
 * list, a fenced code block. A short reply is one block and therefore appears
 * whole, which is the common case and the one this is really for. A long reply
 * appears paragraph by paragraph, which keeps the screen honest about work
 * still being done without spelling it out letter by letter.
 *
 * ## Never split an open fence
 *
 * A blank line inside a fenced code block is not a block boundary. Cutting
 * there would hand the renderer a fence that opens and never closes, and the
 * half it gets renders as something other than code — so the first half of a
 * snippet would appear in one style and the second half in another when the
 * closing fence finally arrived. The fence state is tracked for that reason
 * alone.
 *
 * Pure, and here rather than in the component, for the reason this package
 * already applies to credential wording: there are no component tests, so
 * anything decidable that lives inside a render is a thing nobody can check.
 */

/** A fence opener/closer: up to three spaces of indent, then ``` or ~~~. */
const FENCE = /^ {0,3}(```|~~~)/

/**
 * Split what has accumulated into the part that can be shown and the part that
 * is still arriving.
 *
 * `ready` is always a whole number of blocks and may be empty — an empty
 * `ready` means "nothing has finished yet", not "there is nothing". The caller
 * must therefore flush `rest` when the stream ends, or the last block of every
 * reply would never be shown. That is the one way this can lose text, so it is
 * stated here rather than left to be discovered.
 */
export function splitCompleteBlocks(buffer: string): { ready: string; rest: string } {
	if (buffer.length === 0) return { ready: '', rest: '' }

	const lines = buffer.split('\n')
	let fenceOpen = false
	// Character offset of the end of the last blank line that closed a block.
	let cut = -1
	let offset = 0
	/**
	 * Has anything worth showing appeared yet?
	 *
	 * Without this, a reply that opens with blank lines releases them as a
	 * "block" of nothing, and the transcript row starts with empty lines above
	 * the first word. Blank lines close a block; they do not constitute one.
	 */
	let sawContent = false

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] as string
		const isLast = i === lines.length - 1
		if (FENCE.test(line)) {
			fenceOpen = !fenceOpen
			sawContent = true
		} else if (line.trim().length > 0) {
			sawContent = true
		} else if (
			!fenceOpen &&
			sawContent &&
			// Not the tail: a blank line at the very end may be the first half of
			// a boundary whose next line has not arrived. Holding it costs one
			// block of latency; releasing it can split a paragraph in two.
			!isLast
		) {
			cut = offset + line.length + 1
		}
		offset += line.length + 1
	}

	if (cut < 0) return { ready: '', rest: buffer }
	return { ready: buffer.slice(0, cut), rest: buffer.slice(cut) }
}
