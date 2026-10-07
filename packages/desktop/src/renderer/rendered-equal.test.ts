import { createElement as h } from 'react'
import { describe, expect, it } from 'vitest'
import { renderedEqual } from './rendered-equal.js'

const Row = (_props: Record<string, unknown>) => null
const Other = (_props: Record<string, unknown>) => null

describe('renderedEqual', () => {
	it('takes a rebuilt handler as equal and a changed value as different', () => {
		const first = h(Row, { id: 'm1', onClick: () => 1, speech: { playing: 'a', busy: false } })
		const same = h(Row, { id: 'm1', onClick: () => 2, speech: { playing: 'a', busy: false } })
		const changed = h(Row, { id: 'm1', onClick: () => 1, speech: { playing: 'm1', busy: false } })
		expect(renderedEqual(first, same)).toBe(true)
		expect(renderedEqual(first, changed)).toBe(false)
	})

	it('compares type, key and children', () => {
		expect(
			renderedEqual(h(Row, { a: 1 }, h(Other, { b: 2 })), h(Row, { a: 1 }, h(Other, { b: 2 }))),
		).toBe(true)
		expect(
			renderedEqual(h(Row, { a: 1 }, h(Other, { b: 2 })), h(Row, { a: 1 }, h(Other, { b: 3 }))),
		).toBe(false)
		expect(renderedEqual(h(Row, { a: 1 }), h(Other, { a: 1 }))).toBe(false)
		expect(renderedEqual(h(Row, { key: 'x' }), h(Row, { key: 'y' }))).toBe(false)
	})

	it('treats absent and present output as different, and two absent outputs as equal', () => {
		expect(renderedEqual(undefined, undefined)).toBe(true)
		expect(renderedEqual(undefined, h(Row, {}))).toBe(false)
		expect(renderedEqual(false, h(Row, {}))).toBe(false)
		expect(renderedEqual('a', 'a')).toBe(true)
		expect(renderedEqual('a', 'b')).toBe(false)
	})
})
