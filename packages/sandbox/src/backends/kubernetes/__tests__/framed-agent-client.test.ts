import { describe, expect, it } from 'vitest'

import { decodeFrames, encodeFrame } from './fixtures/framed-agent-client.js'

describe('the framed client decoder', () => {
	it('splits whole frames, keeps a partial one, and reads a terminator as empty', () => {
		const joined = Buffer.concat([encodeFrame('{"a":1}'), encodeFrame(''), encodeFrame('xyz')])
		const whole = decodeFrames(joined)
		expect(whole.frames).toEqual(['{"a":1}', '', 'xyz'])
		expect(whole.rest.length).toBe(0)

		const partial = decodeFrames(joined.subarray(0, joined.length - 1))
		expect(partial.frames).toEqual(['{"a":1}', ''])
		expect(partial.rest.length).toBeGreaterThan(0)
	})

	it.each([
		['an HTTP reply', 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'],
		['a non-hex header of the right width', 'zzzzzzzz\nbody'],
		['a negative length', '-0000001\nbody'],
		['a header that is too short', '0001\nbody'],
		['a newline at position zero', '\n00000001\nx'],
		['a header that is too long', '000000001\nx'],
		['bytes with no newline at all', 'x'.repeat(64)],
	])('throws, naming the first bytes, on %s', (_name, input) => {
		expect(() => decodeFrames(Buffer.from(input, 'latin1'))).toThrow(
			/not speaking the agent protocol/,
		)
	})

	it('bounds how much of a hostile stream the message repeats', () => {
		try {
			decodeFrames(Buffer.from('q'.repeat(100_000), 'latin1'))
			expect.unreachable()
		} catch (error) {
			expect((error as Error).message.length).toBeLessThan(300)
		}
	})
})
