import { describe, expect, it } from 'vitest'
import { stalePalTabs } from './pal-tab-siblings.js'

const rows = [
	{ id: 'k1', palId: 'kiro' },
	{ id: 'k2', palId: 'kiro' },
	{ id: 'm1', palId: 'mira' },
	{ id: 'c1' },
]

describe('stalePalTabs', () => {
	it('lists the other tabs of the same Pal', () => {
		expect(stalePalTabs(rows[1] as never, ['k1', 'c1', 'm1', 'k2'], rows)).toEqual(['k1'])
	})
	it('leaves other Pals and ordinary conversations alone', () => {
		expect(stalePalTabs(rows[2] as never, ['k1', 'c1', 'm1'], rows)).toEqual([])
	})
	it('does nothing for an ordinary conversation', () => {
		expect(stalePalTabs(rows[3] as never, ['k1', 'c1'], rows)).toEqual([])
	})
})
