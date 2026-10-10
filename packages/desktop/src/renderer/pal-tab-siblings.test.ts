import { describe, expect, it } from 'vitest'
import { closableStaleTabs, stalePalTabs } from './pal-tab-siblings.js'

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

describe('closableStaleTabs', () => {
	const reader = (drafts: Record<string, string>, files: Record<string, number> = {}) => ({
		draft: async (id: string) => drafts[id] ?? '',
		attachments: async (id: string) => new Array(files[id] ?? 0).fill({}),
	})
	it('closes tabs with nothing unsent', async () => {
		expect(await closableStaleTabs(['a', 'b'], reader({}))).toEqual(['a', 'b'])
	})
	it('keeps a tab with a draft or attachments', async () => {
		const closable = await closableStaleTabs(
			['a', 'b', 'c'],
			reader({ a: 'half a thought' }, { b: 1 }),
		)
		expect(closable).toEqual(['c'])
	})
	it('keeps a tab that cannot be read', async () => {
		const broken = {
			draft: async () => Promise.reject(new Error('x')),
			attachments: async () => [],
		}
		expect(await closableStaleTabs(['a'], broken)).toEqual([])
	})
})
