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

/**
 * A sentence end followed by whitespace, or a line end. The whitespace is the
 * point: `3.14` and `e.g.` are not sentence ends, and a period at the very end
 * of the buffer may be the first half of `...` or the last character of a
 * word the model has not finished.
 */
const SAFE_CUT = /[.!?:;]\s|\n/g

/**
 * The block rule above, relaxed for a paragraph that is taking a while.
 *
 * A model's paragraph is one long line, so the block rule shows NOTHING of it
 * until its final character — and a reply that is one long paragraph, which
 * many are, is invisible for its whole length. That is the failure the block
 * rule traded the typing effect for, and an operator staring at a blank row
 * for twenty seconds experiences it as "it is not streaming".
 *
 * This releases up to the last point that is safe to show: a line end, or
 * the whitespace after a sentence end. Never mid-word (a released half-word
 * is the typing effect back), never inside an open fence (same reason as the
 * block rule), never inside an open inline code span — a released `` `foo ``
 * with its closing tick still arriving renders as a stray backtick and then
 * re-renders as code, which is worse than waiting.
 *
 * The caller decides WHEN: this is meant to run on a clock, not on every
 * delta, so a fast stream still lands a block at a time and only a slow one
 * degrades to a sentence at a time.
 */
export function splitSafeCut(buffer: string): { ready: string; rest: string } {
	if (buffer.length === 0) return { ready: '', rest: '' }

	let fenceOpen = false
	let cut = -1
	let offset = 0
	let sawContent = false
	for (const line of buffer.split('\n')) {
		const lineEnd = offset + line.length
		if (FENCE.test(line)) {
			fenceOpen = !fenceOpen
			sawContent = true
		} else if (line.trim().length > 0) {
			sawContent = true
		}
		if (!fenceOpen && sawContent) {
			// The line end itself, including a trailing one: unlike the block
			// rule, releasing "text\n" ahead of the "\n" that may follow costs
			// nothing — the renderer sees the same document either way, and a
			// line that is whole is safe to show.
			if (lineEnd < buffer.length) cut = lineEnd + 1
			// Or the last sentence end inside this line, when the line is still
			// growing and nothing after it has arrived.
			else {
				for (const match of line.matchAll(SAFE_CUT)) {
					const at = offset + match.index + match[0].length
					if (backticksBalanced(buffer.slice(0, at))) cut = at
				}
			}
		}
		offset = lineEnd + 1
	}

	if (cut < 0) return { ready: '', rest: buffer }
	return { ready: buffer.slice(0, cut), rest: buffer.slice(cut) }
}

/** An even number of backticks: every inline span that opened has closed. */
function backticksBalanced(text: string): boolean {
	let count = 0
	for (const ch of text) if (ch === '`') count += 1
	return count % 2 === 0
}
