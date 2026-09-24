import { describe, expect, it } from 'vitest'
import { PeerAddressError, parsePeerAddress, udsPeerAddress } from './address.js'

describe('udsPeerAddress', () => {
	it('joins the runtime dir and the session socket filename under uds:', () => {
		expect(udsPeerAddress('/run/namzu', 'sess-1')).toBe('uds:/run/namzu/sess-1.sock')
	})
})

describe('parsePeerAddress', () => {
	it('parses a uds: address', () => {
		expect(parsePeerAddress('uds:/run/namzu/sess-1.sock')).toEqual({
			scheme: 'uds',
			path: '/run/namzu/sess-1.sock',
		})
	})

	it('parses a pipe: address', () => {
		expect(parsePeerAddress('pipe:\\\\.\\pipe\\namzu-abc-def')).toEqual({
			scheme: 'pipe',
			path: '\\\\.\\pipe\\namzu-abc-def',
		})
	})

	it('parses an a2a: address', () => {
		expect(parsePeerAddress('a2a:https://example.com/agent')).toEqual({
			scheme: 'a2a',
			url: 'https://example.com/agent',
		})
	})

	it('refuses an empty scheme body', () => {
		expect(() => parsePeerAddress('uds:')).toThrow(PeerAddressError)
		expect(() => parsePeerAddress('pipe:')).toThrow(PeerAddressError)
		expect(() => parsePeerAddress('a2a:')).toThrow(PeerAddressError)
	})

	it('refuses an unrecognised scheme', () => {
		expect(() => parsePeerAddress('http://example.com')).toThrow(PeerAddressError)
		expect(() => parsePeerAddress('')).toThrow(PeerAddressError)
	})
})
