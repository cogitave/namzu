/**
 * Puts a terminal's output in order for one view.
 *
 * Main sends output as chunks addressed by offset, and sends it from the moment a view is
 * registered, which is before the answer to its attach reaches it. So chunks are held until the
 * answer says where the stream resumes (`end`); after that a chunk already drawn is dropped, one that
 * overlaps is cut to its new part, and one that starts beyond what was drawn is a gap, reported once
 * until the next attach, which the view answers by attaching again from its own offset.
 */
export class TerminalFeed {
	private expected: number | undefined
	private held: { offset: number; data: string }[] | undefined = []
	private gapped = false

	constructor(
		private readonly write: (data: string) => void,
		private readonly onGap: () => void,
	) {}

	/** The offset the next chunk must start at; undefined before the first attach has answered. */
	get next(): number | undefined {
		return this.expected
	}

	/** An attach is in flight: hold what arrives until it answers. */
	begin(): void {
		this.held = []
		this.gapped = false
	}

	/** The attach answered: live output continues at `end`. */
	resume(end: number): void {
		this.expected = Math.max(this.expected ?? 0, end)
		const held = this.held ?? []
		this.held = undefined
		this.gapped = false
		for (const chunk of held) this.accept(chunk.offset, chunk.data)
	}

	/** A snapshot replaced what was drawn: forget the old offset entirely. */
	reset(end: number): void {
		this.expected = end
		const held = this.held ?? []
		this.held = undefined
		this.gapped = false
		for (const chunk of held) this.accept(chunk.offset, chunk.data)
	}

	accept(offset: number, data: string): void {
		if (this.held) {
			this.held.push({ offset, data })
			return
		}
		if (this.expected === undefined) return
		const end = offset + data.length
		if (end <= this.expected) return
		if (offset > this.expected) {
			if (this.gapped) return
			this.gapped = true
			this.onGap()
			return
		}
		const fresh = offset < this.expected ? data.slice(this.expected - offset) : data
		this.expected = end
		this.write(fresh)
	}
}
