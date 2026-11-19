import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExtensionDisclosure, ExtensionRow } from '../shared/extensions-view.js'
import { CollectedView } from './extension-collected.js'
import { kindCounts, kindTitle, recordCountWords, titleSaysAll } from './extensions-model.js'

const ROW = {
	id: 'com.cogitave.activity',
	name: 'Activity Tracker',
	version: '0.3.0',
	publisher: 'Cogitave',
	state: 'running',
	running: true,
} as unknown as ExtensionRow

const D: ExtensionDisclosure = {
	extensionId: 'com.cogitave.activity',
	name: 'Activity Tracker',
	version: '0.3.0',
	publisher: { name: 'Cogitave', contact: 'x@example.com' },
	shownLocale: 'en',
	permissions: [],
	network: 'It does not use the network.',
	dataFolder: 'C:/data',
	dataKinds: [
		{
			id: 'activity.app.minute',
			title: 'Applications',
			description: 'Which program was in front, minute by minute.',
			example: 'Microsoft Excel · 1 h 20 min today',
			fields: [{ name: 'exe', description: 'Program' }],
			retentionDays: 'keep',
		},
		{
			id: 'activity.input.minute',
			description: 'How many keys and clicks happened in a minute.',
			fields: [{ name: 'keys', description: 'Key presses' }],
			retentionDays: 30,
		},
	],
	doesNotCollect: ['Which keys you press.', 'What is on your screen.'],
	doesNotDo: [],
	storage: {
		where: 'On this computer only.',
		encryption: 'Sealed to your Windows user.',
		adminCanRead: false,
	},
	leavesTheMachine: 'Nothing leaves this computer.',
	controller: 'Your organisation',
	licenseRequired: false,
	licence: '',
	noticeVersion: '1',
}

const view = (over: Partial<Parameters<typeof CollectedView>[0]> = {}) =>
	renderToStaticMarkup(
		createElement(CollectedView, {
			row: ROW,
			disclosure: D,
			counts: new Map([['activity.app.minute', 4380]]),
			recent: undefined,
			error: undefined,
			onBack: () => {},
			onShowRecent: () => {},
			...over,
		}),
	)

describe('What is collected, as a page of Settings', () => {
	it('opens with one sentence saying what it is', () => {
		expect(view()).toContain(
			'This is what Activity Tracker records on this computer, and how long it keeps it.',
		)
	})
	it('has one group for each kind of data: title, what it records, an example, how long, how many', () => {
		const m = view()
		const titles = [...m.matchAll(/<h2 class="settings-section-title">([^<]+)<\/h2>/g)].map(
			(x) => x[1],
		)
		expect(titles[0]).toBe('Applications')
		expect(titles).toContain('How many keys and clicks happened in a minute')
		expect(m).toContain('>What it records<')
		expect(m).toContain('Which program was in front, minute by minute.')
		expect(m).toContain('>For example<')
		expect(m).toContain('Microsoft Excel · 1 h 20 min today')
		expect(m).toContain('>How long it is kept<')
		expect(m).toContain('Kept until your organisation deletes it')
		expect(m).toContain('Kept 30 days')
		expect(m).toContain('4 380 records')
	})
	it('lists what is never recorded and where it is kept, as short rows', () => {
		const m = view()
		expect(m).toContain('Never recorded')
		expect(m).toContain('Which keys you press')
		expect(m).toContain('What is on your screen')
		expect(m).toContain('Where it is kept')
		expect(m).toContain('On this computer only')
		expect(m).toContain('Sealed to your Windows user.')
	})
	it('shows no field name and no raw row until the person asks for recent records', () => {
		const m = view()
		expect(m).not.toMatch(/<table|>exe<|>keys</)
		expect(m).toContain('Show recent records')
		const open = view({
			recent: {
				kind: 'activity.app.minute',
				table: { kind: 'activity.app.minute', columns: ['exe'], rows: [['EXCEL.EXE']] },
			},
		})
		expect(open).toContain('<table')
		expect(open).toContain('EXCEL.EXE')
		expect(open).toContain('>Program<')
	})
	it('has no id, no path and no technical word', () => {
		const m = view()
		expect(m).not.toContain('C:/data')
		expect(m).not.toMatch(/manifest|daemon|runner|schema|retentionDays/i)
	})
	it('says only that it records nothing for an extension that collects nothing', () => {
		const m = view({ disclosure: { ...D, dataKinds: [], doesNotCollect: [] } })
		expect(m).toContain('Activity Tracker records nothing.')
		expect(m).not.toContain('Where it is kept')
		expect(m).not.toContain('Never recorded')
	})
	it('does not count while it is off', () => {
		const m = view({ row: { ...ROW, running: false } as ExtensionRow, counts: undefined })
		expect(m).toContain('Counted while it is on')
		expect(m).not.toContain('Show recent records')
	})
})

describe('the words of that page', () => {
	it('reads the counts answer by kind', () => {
		const c = kindCounts({
			kinds: [{ id: 'a', rows: 3 }, { id: 'b', rows: 0 }, { id: 1, rows: 2 }, null],
		})
		expect([...c]).toEqual([
			['a', 3],
			['b', 0],
		])
		expect(kindCounts('nope').size).toBe(0)
	})
	it('words the number of records', () => {
		expect(recordCountWords(undefined)).toBe('Not counted yet')
		expect(recordCountWords(0)).toBe('Nothing yet')
		expect(recordCountWords(1)).toBe('1 record')
		expect(recordCountWords(1234567)).toBe('1 234 567 records')
	})
	it('titles a group with its own title, or the start of what it records', () => {
		expect(kindTitle({ title: 'Applications', description: 'x' })).toBe('Applications')
		expect(kindTitle({ description: 'Which program was in front.' })).toBe(
			'Which program was in front',
		)
		expect(kindTitle({ description: 'A'.repeat(80) }).length).toBeLessThanOrEqual(46)
	})
})

describe('a heading that already says the whole description', () => {
	it('hides the repeated What it records row', () => {
		expect(titleSaysAll({ description: 'Window titles.' })).toBe(true)
		expect(titleSaysAll({ title: 'Applications', description: 'Seconds per application.' })).toBe(
			false,
		)
		expect(titleSaysAll({ description: 'A'.repeat(80) })).toBe(false)
	})
})
