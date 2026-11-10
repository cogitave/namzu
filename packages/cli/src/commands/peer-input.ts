/** Message text for `namzu peers send --file`, read with a ceiling and decoded strictly. */

import { open } from 'node:fs/promises'
import { MAX_PEER_MESSAGE_TEXT_BYTES } from '@namzu/sdk'

export type PeerInput =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'too-large' }
	| { readonly kind: 'invalid'; readonly reason: string }

const LIMIT = MAX_PEER_MESSAGE_TEXT_BYTES + 1

/** Turn bytes into text, or say why they are not a message. At most one trailing line break is dropped. */
export function decodePeerInput(bytes: Uint8Array): PeerInput {
	if (bytes.byteLength > MAX_PEER_MESSAGE_TEXT_BYTES) return { kind: 'too-large' }
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		return { kind: 'invalid', reason: 'The input is not valid UTF-8 text.' }
	}
	if (text.includes('\0')) return { kind: 'invalid', reason: 'The input contains NUL bytes.' }
	return { kind: 'text', text: text.replace(/\r?\n$/, '') }
}

/** Read at most one byte past the limit from a stream, then stop. A terminal gives nothing. */
export async function readBoundedStream(
	input: AsyncIterable<Uint8Array | string> & { readonly isTTY?: boolean; destroy?: () => void },
): Promise<Uint8Array> {
	if (input.isTTY) return new Uint8Array()
	const chunks: Buffer[] = []
	let total = 0
	for await (const chunk of input) {
		const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
		chunks.push(buffer)
		total += buffer.length
		if (total >= LIMIT) break
	}
	return Buffer.concat(chunks).subarray(0, LIMIT)
}

/** Read at most one byte past the limit from a path; never buffers the rest of a huge file or device. */
export async function readBoundedFile(path: string): Promise<Uint8Array> {
	const handle = await open(path, 'r')
	try {
		const buffer = Buffer.alloc(LIMIT)
		let filled = 0
		while (filled < LIMIT) {
			const { bytesRead } = await handle.read(buffer, filled, LIMIT - filled, null)
			if (bytesRead === 0) break
			filled += bytesRead
		}
		return buffer.subarray(0, filled)
	} finally {
		await handle.close()
	}
}
