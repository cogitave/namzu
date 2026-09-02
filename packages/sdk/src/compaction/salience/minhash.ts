/**
 * Near-duplicate detection with MinHash over word shingles.
 *
 * Two tool results are rarely byte-identical — a timestamp, a duration,
 * a line number moves — and still the same output. Three-word shingles
 * hashed 64 ways give a Jaccard estimate that is stable against those
 * edits and cheap enough to compare every message against every other
 * once per pass at the sizes a run reaches. Hashing is FNV-1a with a
 * per-slot seed; nothing here needs to be cryptographic, only consistent
 * within a process.
 */

const HASHES = 64
const SHINGLE = 3

function fnv1a(text: string, seed: number): number {
	let hash = (0x811c9dc5 ^ seed) >>> 0
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

/** The signature of `tokens`; an empty signature for fewer than one shingle. */
export function minhash(tokens: readonly string[]): Uint32Array {
	const signature = new Uint32Array(HASHES).fill(0xffffffff)
	if (tokens.length < SHINGLE) {
		if (tokens.length === 0) return signature
		const single = tokens.join(' ')
		for (let slot = 0; slot < HASHES; slot += 1) signature[slot] = fnv1a(single, slot)
		return signature
	}
	for (let i = 0; i + SHINGLE <= tokens.length; i += 1) {
		const shingle = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`
		for (let slot = 0; slot < HASHES; slot += 1) {
			const h = fnv1a(shingle, slot)
			if (h < (signature[slot] as number)) signature[slot] = h
		}
	}
	return signature
}

/** Estimated Jaccard similarity of two signatures, 0..1. */
export function similarity(a: Uint32Array, b: Uint32Array): number {
	let same = 0
	for (let slot = 0; slot < HASHES; slot += 1) if (a[slot] === b[slot]) same += 1
	return same / HASHES
}

export function isEmptySignature(signature: Uint32Array): boolean {
	return signature.every((h) => h === 0xffffffff)
}
