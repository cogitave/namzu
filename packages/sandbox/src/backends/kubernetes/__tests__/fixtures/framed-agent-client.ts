/**
 * A minimal framed client for the guest agent, for the suites that drive
 * `agent/agent.cjs` directly over a socket.
 *
 * It re-implements the `<8-hex byte length>\n<utf8 JSON>` framing rather
 * than importing the agent's own `frame` / `FrameReader`: these suites
 * assert that the wire the pod-network listener serves is the SAME wire
 * the vsock listener serves, and a client built from the code under test
 * could not tell the difference if the agent changed it.
 */

import { connect } from 'node:net'

const LENGTH_PREFIX_HEX = 8

/** Encode one request frame exactly as `transport.ts` writes it. */
export function encodeFrame(payload: string): Buffer {
	const body = Buffer.from(payload, 'utf8')
	const header = Buffer.from(
		`${body.length.toString(16).padStart(LENGTH_PREFIX_HEX, '0')}\n`,
		'ascii',
	)
	return Buffer.concat([header, body])
}

/**
 * Split a received buffer into whole frames; a zero-length frame is `''`.
 *
 * `rest` is a `subarray` of what arrived, so it is a `Buffer` over an
 * `ArrayBufferLike` — the widest of the buffer types, and NOT the
 * `Buffer<ArrayBuffer>` that `Buffer.alloc` infers. An accumulator this
 * feeds is annotated `Buffer` for that reason; inferring it from an empty
 * `Buffer.alloc(0)` narrows it to a type this cannot be assigned to.
 */
export function decodeFrames(buffer: Buffer): { frames: string[]; rest: Buffer } {
	const frames: string[] = []
	let rest = buffer
	for (;;) {
		const newline = rest.indexOf(0x0a)
		if (newline < LENGTH_PREFIX_HEX) break
		const length = Number.parseInt(rest.subarray(0, newline).toString('ascii'), 16)
		const start = newline + 1
		if (rest.length < start + length) break
		frames.push(rest.subarray(start, start + length).toString('utf8'))
		rest = rest.subarray(start + length)
	}
	return { frames, rest }
}

export interface FramedExchange {
	/** Every frame the agent wrote, in order. A terminator reads as `''`. */
	readonly frames: string[]
	/** The parsed first frame — what a single-reply op answers with. */
	readonly reply: Record<string, unknown>
	/** True when the agent closed the connection rather than the client. */
	readonly closedByAgent: boolean
}

/**
 * Dial the agent on loopback, write one request frame, and read until
 * the agent closes the connection. Every op these suites use answers
 * and then ends, so "until close" is the whole exchange.
 */
export async function sendFramedRequest(
	port: number,
	request: unknown,
	timeoutMs = 10_000,
): Promise<FramedExchange> {
	return await new Promise<FramedExchange>((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port })
		const frames: string[] = []
		let rest: Buffer = Buffer.alloc(0)
		let closedByAgent = false
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`framed request timed out after ${timeoutMs}ms`))
		}, timeoutMs)
		timer.unref()
		socket.on('connect', () => socket.write(encodeFrame(JSON.stringify(request))))
		socket.on('data', (chunk) => {
			const decoded = decodeFrames(rest.length === 0 ? chunk : Buffer.concat([rest, chunk]))
			frames.push(...decoded.frames)
			rest = decoded.rest
		})
		socket.on('end', () => {
			closedByAgent = true
		})
		socket.on('error', (error) => {
			clearTimeout(timer)
			reject(error)
		})
		socket.on('close', () => {
			clearTimeout(timer)
			let reply: Record<string, unknown> = {}
			if (frames[0]) reply = JSON.parse(frames[0]) as Record<string, unknown>
			resolve({ frames, reply, closedByAgent })
		})
	})
}
