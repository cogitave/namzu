/**
 * The last stretch of a terminal's output, addressed by absolute offset.
 *
 * Offsets count UTF-16 code units from the first character ever printed and never
 * reset, so a viewer holding offset N can ask for exactly what followed it. Memory
 * is bounded: once the retained text exceeds the capacity, the oldest whole chunks
 * go, then a prefix of the oldest remaining one.
 */
export class OutputRing {
	private chunks: { start: number; text: string }[] = []
	private retained = 0
	private total = 0

	constructor(private readonly capacity: number) {
		if (!Number.isSafeInteger(capacity) || capacity < 1)
			throw new RangeError('A ring needs a capacity of at least one character.')
	}

	/** Offset of the first character still held. */
	get start(): number {
		return this.total - this.retained
	}

	/** Offset after the last character ever appended. */
	get end(): number {
		return this.total
	}

	append(text: string): number {
		if (text.length === 0) return this.total
		this.chunks.push({ start: this.total, text })
		this.total += text.length
		this.retained += text.length
		while (this.retained > this.capacity) {
			const first = this.chunks[0]
			if (!first) break
			const excess = this.retained - this.capacity
			if (excess >= first.text.length) {
				this.chunks.shift()
				this.retained -= first.text.length
				continue
			}
			// Never begin on the second half of a surrogate pair.
			let cut = excess
			const code = first.text.charCodeAt(cut)
			if (code >= 0xdc00 && code <= 0xdfff) cut += 1
			first.text = first.text.slice(cut)
			first.start += cut
			this.retained -= cut
		}
		return this.total
	}

	/** Everything from `offset` to the end, or null when `offset` has been dropped or is ahead. */
	slice(offset: number): string | null {
		if (offset < this.start || offset > this.total) return null
		if (offset === this.total) return ''
		const parts: string[] = []
		for (const chunk of this.chunks) {
			const end = chunk.start + chunk.text.length
			if (end <= offset) continue
			parts.push(offset > chunk.start ? chunk.text.slice(offset - chunk.start) : chunk.text)
		}
		return parts.join('')
	}
}
