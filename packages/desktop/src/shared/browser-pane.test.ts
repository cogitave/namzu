import { describe, expect, it } from 'vitest'
import { readBrowserRequest } from './browser-pane.js'

describe('readBrowserRequest', () => {
	it('reads each kind', () => {
		expect(readBrowserRequest({ kind: 'go', address: 'https://a.b' })).toEqual({
			kind: 'go',
			address: 'https://a.b',
		})
		expect(readBrowserRequest({ kind: 'back' })).toEqual({ kind: 'back' })
		expect(readBrowserRequest({ kind: 'freeze', extra: 1 })).toEqual({ kind: 'freeze' })
		expect(readBrowserRequest({ kind: 'place', bounds: null })).toEqual({
			kind: 'place',
			bounds: null,
		})
		expect(
			readBrowserRequest({ kind: 'place', bounds: { x: 1, y: 2, width: 3, height: 4, extra: 9 } }),
		).toEqual({ kind: 'place', bounds: { x: 1, y: 2, width: 3, height: 4 } })
	})
	it('refuses what is not a request', () => {
		for (const bad of [
			null,
			'go',
			{ kind: 'eval' },
			{ kind: 'go', address: 5 },
			{ kind: 'go', address: 'x'.repeat(5000) },
			{ kind: 'place', bounds: { x: 1, y: 2, width: Number.NaN, height: 4 } },
			{ kind: 'place', bounds: { x: 1 } },
			{ kind: 'close' },
		])
			expect(() => readBrowserRequest(bad)).toThrow()
	})
})

it('reads the person’s take-over and hand-back of an agent tab', () => {
	expect(readBrowserRequest({ kind: 'takeover', tabId: 'a' })).toEqual({
		kind: 'takeover',
		tabId: 'a',
	})
	expect(readBrowserRequest({ kind: 'handback', tabId: 'a' })).toEqual({
		kind: 'handback',
		tabId: 'a',
	})
	expect(() => readBrowserRequest({ kind: 'takeover' })).toThrow()
})
