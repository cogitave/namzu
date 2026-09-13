import { createHash } from 'node:crypto'
import { evidenceTokenEntries, evidenceTokenKey } from '../../utils/evidence-tokens.js'
import { RECORD_BYTES } from './io.js'

export const EVIDENCE_CHUNK_BYTES = 65_536
export const SEARCH_OVERLAP_BYTES = 1_024
const FILTER_BYTES = 1_024
const TOKEN_FILTER_PREFIX = `tokens-v1:${digest(`${process.version}:${process.versions.v8}:${process.versions.unicode}`).slice(0, 16)}:`

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
	const bit = hash % (bits.length * 8)
	return ((bits[bit >>> 3] ?? 0) & (1 << (bit & 7))) !== 0
}
function set(bits: Buffer, hash: number): void {
	const bit = hash % (bits.length * 8)
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

function tokenHash(token: string): number {
	let hash = 2166136261
	for (let i = 0; i < token.length; i++) hash = Math.imul(hash ^ token.charCodeAt(i), 16777619)
	return hash >>> 0
}

/** Negative-only membership filter using the same whole-token keys as discovery. */
export function tokenFilter(text: string): string {
	const bits = Buffer.alloc(text.length <= 1024 ? 128 : text.length <= 8192 ? 512 : FILTER_BYTES)
	for (const match of evidenceTokenEntries(text)) {
		const hash = tokenHash(evidenceTokenKey(match[0]))
		set(bits, hash)
		set(bits, second(hash))
	}
	return TOKEN_FILTER_PREFIX + bits.toString('base64')
}

export function mayContainToken(filter: string | undefined, query: string): boolean {
	if (filter === undefined || !filter.startsWith(TOKEN_FILTER_PREFIX)) return true
	const bits = Buffer.from(filter.slice(TOKEN_FILTER_PREFIX.length), 'base64')
	if (![128, 512, FILTER_BYTES].includes(bits.length))
		throw new Error('Invalid evidence token filter.')
	const hash = tokenHash(evidenceTokenKey(query))
	return contains(bits, hash) && contains(bits, second(hash))
}

/** Internal manifest, authenticated by the digest recorded in tool_completed. */
export interface SpillManifest {
	version: 1
	bytes: number
	chars?: number
	chunkBytes: number
	chunks: { sha256: string; filter: string; tokenFilter?: string; characterOffset?: number }[]
}

/** Optional acceleration must not reduce the previously retainable output size. */
export function encodeSpillManifest(manifest: SpillManifest): string {
	const encoded = JSON.stringify(manifest)
	if (Buffer.byteLength(encoded, 'utf8') <= RECORD_BYTES) return encoded
	return JSON.stringify({
		...manifest,
		chunks: manifest.chunks.map(({ tokenFilter: _filter, ...chunk }) => chunk),
	})
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
		const text = bytes
			.subarray(offset, offset + EVIDENCE_CHUNK_BYTES + SEARCH_OVERLAP_BYTES)
			.toString('utf8')
		chunks.push({
			characterOffset: chars,
			sha256: digest(bytes.subarray(offset, offset + EVIDENCE_CHUNK_BYTES)),
			filter: textFilter(text),
			tokenFilter: tokenFilter(text),
		})
		chars += bytes
			.subarray(boundary(offset), boundary(offset + EVIDENCE_CHUNK_BYTES))
			.toString('utf8').length
	}
	return encodeSpillManifest({
		version: 1,
		bytes: bytes.length,
		chars,
		chunkBytes: EVIDENCE_CHUNK_BYTES,
		chunks,
	})
}
