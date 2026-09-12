import { createHash } from 'node:crypto'

export const EVIDENCE_CHUNK_BYTES = 65_536
export const SEARCH_OVERLAP_BYTES = 1_024
const FILTER_BYTES = 1_024

export function digest(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex')
}

function hashAt(text: string, offset: number): number {
	let hash = 2166136261
	for (let i = 0; i < 3; i++) hash = Math.imul(hash ^ text.charCodeAt(offset + i), 16777619)
	return hash >>> 0
}
function second(hash: number): number {
	return Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0
}
function contains(bits: Buffer, hash: number): boolean {
	const bit = hash % (FILTER_BYTES * 8)
	return ((bits[bit >>> 3] ?? 0) & (1 << (bit & 7))) !== 0
}
function set(bits: Buffer, hash: number): void {
	const bit = hash % (FILTER_BYTES * 8)
	bits[bit >>> 3] = (bits[bit >>> 3] ?? 0) | (1 << (bit & 7))
}

// A negative rules out a literal match; a positive always needs source verification.
export function textFilter(text: string): string {
	const bits = Buffer.alloc(FILTER_BYTES)
	for (let i = 0; i + 2 < text.length; i++) {
		const hash = hashAt(text, i)
		set(bits, hash)
		set(bits, second(hash))
	}
	return bits.toString('base64')
}

export function mayContain(filter: string, query: string): boolean {
	const bits = Buffer.from(filter, 'base64')
	if (bits.length !== FILTER_BYTES) throw new Error('Invalid evidence filter.')
	for (let i = 0; i + 2 < query.length; i++) {
		const hash = hashAt(query, i)
		if (!contains(bits, hash) || !contains(bits, second(hash))) return false
	}
	return true
}

/** Internal manifest, authenticated by the digest recorded in tool_completed. */
export interface SpillManifest {
	version: 1
	bytes: number
	chars?: number
	chunkBytes: number
	chunks: { sha256: string; filter: string; characterOffset?: number }[]
}

export function spillManifest(bytes: Buffer): string {
	const chunks: SpillManifest['chunks'] = []
	let chars = 0
	const boundary = (position: number) => {
		let offset = position
		while (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80) offset++
		return Math.min(offset, bytes.length)
	}
	for (let offset = 0; offset < bytes.length; offset += EVIDENCE_CHUNK_BYTES) {
		chunks.push({
			characterOffset: chars,
			sha256: digest(bytes.subarray(offset, offset + EVIDENCE_CHUNK_BYTES)),
			filter: textFilter(
				bytes
					.subarray(offset, offset + EVIDENCE_CHUNK_BYTES + SEARCH_OVERLAP_BYTES)
					.toString('utf8'),
			),
		})
		chars += bytes
			.subarray(boundary(offset), boundary(offset + EVIDENCE_CHUNK_BYTES))
			.toString('utf8').length
	}
	return JSON.stringify({
		version: 1,
		bytes: bytes.length,
		chars,
		chunkBytes: EVIDENCE_CHUNK_BYTES,
		chunks,
	})
}
