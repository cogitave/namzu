import { describe, expect, it } from 'vitest'

import { refusedByLayers } from '../policy.js'

describe('tools refused by name across permission layers', () => {
	it('names a tool one layer denies', () => {
		expect(refusedByLayers([{ web_fetch: 'deny', bash: 'allow' }])).toEqual(['web_fetch'])
	})

	it('reads each layer on its own, so a deny in a second layer still counts', () => {
		expect(
			refusedByLayers([{ edit: 'allow' }, { web_fetch: 'deny' }, { web_search: 'deny' }]),
		).toEqual(['web_fetch', 'web_search'])
	})

	it('holds a deny in one layer whatever another layer allows', () => {
		expect(refusedByLayers([{ web_fetch: 'allow' }, { web_fetch: 'deny' }])).toEqual(['web_fetch'])
	})

	it('leaves a tool in place when only some of its calls are refused', () => {
		expect(refusedByLayers([{ bash: { 'rm *': 'deny' } }])).toEqual([])
	})

	it('names nothing for no layers or an undefined one', () => {
		expect(refusedByLayers([])).toEqual([])
		expect(refusedByLayers([undefined])).toEqual([])
	})
})
