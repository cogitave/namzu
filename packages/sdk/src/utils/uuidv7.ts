import { randomFillSync } from 'node:crypto'

/**
 * UUID version 7 (RFC 9562 §5.7): a 48-bit Unix millisecond timestamp, then
 * randomness, so ids sort by creation time as plain strings.
 *
 * Every `generate*Id` mints through here. A session log names its records,
 * turns and child sessions by these ids, and a directory listing or an index
 * ordered by id is then ordered by time with no second column.
 *
 * **Monotonic within one process.** RFC 9562 §6.2 method 3: inside one
 * millisecond, or when the wall clock steps backwards, the 42 bits after the
 * version are treated as a counter and incremented, so every id this
 * generator returns sorts strictly after the one before it. When that counter
 * would overflow, the timestamp field advances by one millisecond rather than
 * wrapping. The 32 bits after the counter stay random on every call, which is
 * what keeps two processes minting in the same millisecond apart.
 *
 * Layout (hex digits): `tttttttt-tttt-7ccc-Vccc-cccrrrrrrrr`, where `t` is
 * the timestamp, `c` the 42-bit counter (12 bits in `rand_a`, 30 at the top of
 * `rand_b`), `V` the RFC variant nibble `8`–`b`, and `r` fresh randomness.
 */
export interface UuidV7Source {
	/** Current time in Unix milliseconds. */
	readonly now?: () => number
	/** Fills the buffer with cryptographically strong random bytes. */
	readonly random?: (bytes: Uint8Array) => void
}

const COUNTER_BITS = 42
const COUNTER_LIMIT = 2 ** COUNTER_BITS
/** A fresh millisecond seeds the counter below half its range, leaving room to count. */
const COUNTER_SEED_LIMIT = 2 ** (COUNTER_BITS - 1)
const MAX_TIMESTAMP = 2 ** 48 - 1

function hex(value: number, digits: number): string {
	return value.toString(16).padStart(digits, '0')
}

/** A generator with its own monotonic state. Tests inject the clock and the randomness. */
export function createUuidV7Generator(source: UuidV7Source = {}): () => string {
	const now = source.now ?? Date.now
	const random =
		source.random ??
		((bytes: Uint8Array) => {
			randomFillSync(bytes)
		})
	let lastMs = -1
	let counter = 0
	const bytes = new Uint8Array(10)

	return () => {
		random(bytes)
		const clock = Math.floor(now())
		if (!Number.isSafeInteger(clock) || clock < 0 || clock > MAX_TIMESTAMP) {
			throw new RangeError(`UUIDv7 timestamp out of range: ${clock}`)
		}
		if (clock > lastMs) {
			lastMs = clock
			// 41 random bits: bytes 0..5, top bit of the 42 cleared.
			counter =
				((bytes[0] as number) & 0x01) * 2 ** 40 +
				(bytes[1] as number) * 2 ** 32 +
				(((bytes[2] as number) << 24) >>> 0) +
				((bytes[3] as number) << 16) +
				((bytes[4] as number) << 8) +
				(bytes[5] as number)
			if (counter >= COUNTER_SEED_LIMIT) counter -= COUNTER_SEED_LIMIT
		} else {
			// Same millisecond, or the clock stepped back: count forward from the last id.
			counter += 1
			if (counter >= COUNTER_LIMIT) {
				if (lastMs >= MAX_TIMESTAMP) throw new RangeError('UUIDv7 timestamp exhausted')
				lastMs += 1
				counter = 0
			}
		}

		const counterHigh = Math.floor(counter / 2 ** 30) // 12 bits
		const counterLow = counter % 2 ** 30 // 30 bits
		const tail =
			(((bytes[6] as number) << 24) >>> 0) +
			((bytes[7] as number) << 16) +
			((bytes[8] as number) << 8) +
			(bytes[9] as number)

		const time = hex(lastMs, 12)
		// rand_b is 64 bits: the variant `10`, the counter's low 30 bits, then
		// 32 random bits. `high` is its top 32 bits.
		const high = hex(0x80000000 + counterLow, 8)
		return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hex(counterHigh, 3)}-${high.slice(0, 4)}-${high.slice(4, 8)}${hex(tail, 8)}`
	}
}

/** The process-wide generator every id factory shares. */
export const uuidv7: () => string = createUuidV7Generator()

/** The Unix millisecond timestamp a UUIDv7 carries, or `undefined` for any other spelling. */
export function uuidv7Timestamp(value: string): number | undefined {
	if (
		!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
			value,
		)
	)
		return undefined
	return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16)
}
