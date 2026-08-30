/**
 * Retain the newest bytes of one command-output stream under a hard bound.
 *
 * Bytes stay undecoded until the command closes, so a UTF-8 code point split
 * across ordinary stream chunks is not corrupted. The backing store grows
 * geometrically up to the configured cap and becomes a ring only when output
 * crosses it; no incoming chunk is retained by reference.
 */
export class BoundedTailCapture {
	private storage = Buffer.alloc(0)
	private start = 0
	private length = 0
	private lostBytes = false

	constructor(private readonly capBytes: number) {
		if (!Number.isSafeInteger(capBytes) || capBytes <= 0) {
			throw new RangeError('BoundedTailCapture capBytes must be a positive safe integer')
		}
	}

	push(chunk: Buffer): void {
		if (chunk.length === 0) return

		if (chunk.length >= this.capBytes) {
			if (chunk.length > this.capBytes || this.length > 0) this.lostBytes = true
			this.ensureCapacity(this.capBytes)
			chunk.copy(this.storage, 0, chunk.length - this.capBytes)
			this.start = 0
			this.length = this.capBytes
			return
		}

		const combinedLength = this.length + chunk.length
		if (combinedLength <= this.capBytes) {
			this.ensureCapacity(combinedLength)
			chunk.copy(this.storage, this.length)
			this.length = combinedLength
			return
		}

		this.lostBytes = true
		this.ensureCapacity(this.capBytes)
		const end = (this.start + this.length) % this.capBytes
		const first = Math.min(chunk.length, this.capBytes - end)
		chunk.copy(this.storage, end, 0, first)
		if (first < chunk.length) chunk.copy(this.storage, 0, first)
		this.start = (this.start + combinedLength - this.capBytes) % this.capBytes
		this.length = this.capBytes
	}

	/** Ordered copy of the retained raw bytes. */
	get bytes(): Buffer {
		const ordered = Buffer.allocUnsafe(this.length)
		if (this.length === 0) return ordered
		const first = Math.min(this.length, this.storage.length - this.start)
		this.storage.copy(ordered, 0, this.start, this.start + first)
		if (first < this.length) this.storage.copy(ordered, first, 0, this.length - first)
		return ordered
	}

	get text(): string {
		const ordered = this.bytes
		let offset = 0
		// Tail eviction can leave continuation bytes from a valid UTF-8 code
		// point at the new left edge. They are an artifact of the cut, not an
		// authored replacement character, so discard only that partial prefix.
		if (this.lostBytes) {
			while (offset < ordered.length) {
				const firstByte = ordered[offset]
				if (firstByte === undefined || (firstByte & 0xc0) !== 0x80) break
				offset++
			}
		}
		return ordered.toString('utf8', offset)
	}

	get truncated(): boolean {
		return this.lostBytes
	}

	/** Diagnostic invariant used by the internal killing observers. */
	get retainedBytes(): number {
		return this.length
	}

	/** Diagnostic invariant used by the internal killing observers. */
	get allocatedBytes(): number {
		return this.storage.length
	}

	private ensureCapacity(required: number): void {
		if (this.storage.length >= required) return
		let capacity = Math.max(1, this.storage.length)
		while (capacity < required) capacity = Math.min(this.capBytes, capacity * 2)
		const grown = Buffer.allocUnsafe(capacity)
		if (this.length > 0) {
			const first = Math.min(this.length, this.storage.length - this.start)
			this.storage.copy(grown, 0, this.start, this.start + first)
			if (first < this.length) this.storage.copy(grown, first, 0, this.length - first)
		}
		this.storage = grown
		this.start = 0
	}
}
