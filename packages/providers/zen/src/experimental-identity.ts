import { createHash, randomBytes } from 'node:crypto'

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Pinned to the OpenCode request shape observed in the 2026-09-28 trial. */
export const EXPERIMENTAL_OPENCODE_USER_AGENT =
	'opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

function timeHex(value: bigint): string {
	const time = Buffer.alloc(6)
	for (let index = 0; index < time.length; index++) {
		time[index] = Number((value >> BigInt(40 - index * 8)) & 0xffn)
	}
	return time.toString('hex')
}

function base62(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('')
}

/** Stable when the CLI constructs a new provider for each turn of one conversation. */
export function experimentalOpenCodeSessionId(namzuSessionId: string): string {
	const hash = createHash('sha256').update(namzuSessionId).digest()
	const uuidTime = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/i.exec(namzuSessionId)
	const milliseconds = uuidTime
		? BigInt(`0x${uuidTime[1]}${uuidTime[2]}`)
		: BigInt(`0x${hash.subarray(0, 6).toString('hex')}`)
	return `ses_${timeHex(~(milliseconds * 0x1000n + 1n))}${base62(hash.subarray(6, 20))}`
}

/** One OpenCode-shaped message id per outbound model request. */
export function experimentalOpenCodeRequestId(): string {
	return `msg_${timeHex(BigInt(Date.now()) * 0x1000n + 1n)}${base62(randomBytes(14))}`
}
