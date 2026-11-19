import { describe, expect, it } from 'vitest'
import { readBounds, readExtensionId, readPageId, readTheme } from './extension-ui.js'
import { readDisclosure, readExtensionRow } from './extensions-view.js'

describe('what the renderer may tell the main process about a page', () => {
	it('a rectangle is four finite numbers in a sane range', () => {
		expect(readBounds({ x: 1, y: 2, width: 3, height: 4 })).toEqual({
			x: 1,
			y: 2,
			width: 3,
			height: 4,
		})
		for (const bad of [
			null,
			'x',
			{ x: 1 },
			{ x: 1, y: 2, width: 3, height: Number.NaN },
			{ x: 1, y: 2, width: 3, height: 1e9 },
			{ x: '1', y: 2, width: 3, height: 4 },
		])
			expect(readBounds(bad)).toBeUndefined()
	})
	it('an extension id and a page id are plain names', () => {
		expect(readExtensionId('com.cogitave.activity')).toBe('com.cogitave.activity')
		for (const bad of ['', '../x', 'a b', 'COM.X.Y', 'a'.repeat(120), 7, null, 'a..b.c'])
			expect(readExtensionId(bad)).toBeUndefined()
		expect(readPageId('today')).toBe('today')
		for (const bad of ['', 'Today', '../x', 'a/b', 3]) expect(readPageId(bad)).toBeUndefined()
	})
	it('theme tokens keep their fixed names and refuse values that could close a rule', () => {
		const t = readTheme({
			dark: true,
			tokens: {
				'--ns-bg': '#000',
				'--ns-fg': 'red; } body { display: none',
				'--other': 'x',
				'--ns-font': 'Geist, sans-serif',
			},
		})
		expect(t).toEqual({
			dark: true,
			tokens: { '--ns-bg': '#000', '--ns-font': 'Geist, sans-serif' },
		})
		expect(readTheme({ dark: 'yes', tokens: {} })).toBeUndefined()
		expect(readTheme(null)).toBeUndefined()
	})
})

describe('the new fields of a row and a disclosure', () => {
	const base = {
		id: 'com.example.a',
		name: 'A',
		version: '1.0.0',
		publisher: 'P',
		state: 'license-grace',
		chip: 'Licence not checked',
		dev: false,
		needs: [],
		enabled: true,
		languages: ['en'],
		shownLocale: 'en',
		running: true,
		grants: [],
	}
	it('reads the licence kind, the service host and the offline days; an unknown kind reads as none', () => {
		const r = readExtensionRow({
			...base,
			licenceKind: 'service',
			licenceHost: 'license.example.com',
			licenceGraceDaysLeft: 3,
			licenceChecked: { lastAt: 5, lastError: 'unreachable' },
		})
		expect(r).toMatchObject({
			state: 'license-grace',
			licenceKind: 'service',
			licenceHost: 'license.example.com',
			licenceGraceDaysLeft: 3,
			licenceChecked: { lastAt: 5, lastError: 'unreachable' },
		})
		expect(readExtensionRow({ ...base, licenceKind: 'wat' })?.licenceKind).toBe('none')
		expect(readExtensionRow({ ...base, state: 'license-revoked' })?.state).toBe('license-revoked')
	})
	it('reads the background block and the ui block, and drops what is not well formed', () => {
		const r = readExtensionRow({
			...base,
			background: {
				indicator: 'tray',
				indicatorLabel: 'Recording.',
				defaultOn: true,
				enabled: true,
				hostedBy: 'runner',
				signin: { registered: true, disabledByOs: true },
			},
			ui: {
				icon: 'ui/icon.svg',
				accent: '#2F6F4F',
				pages: [
					{ id: 'today', title: 'Today', slot: 'settings', usesNetwork: false, minHeight: 360 },
					{ id: 'x', slot: 'elsewhere' },
				],
				chips: [
					{ id: 'recording', state: 'gap', label: 'Gap', tone: 'warn', opens: 'today' },
					{ id: 'bad', state: 's', label: 'L', tone: 'purple' },
				],
			},
		})
		expect(r?.background).toMatchObject({
			indicator: 'tray',
			hostedBy: 'runner',
			signin: { registered: true, disabledByOs: true },
		})
		expect(r?.ui?.pages).toEqual([
			{ id: 'today', title: 'Today', slot: 'settings', usesNetwork: false, minHeight: 360 },
		])
		expect(r?.ui?.chips).toEqual([
			{ id: 'recording', state: 'gap', label: 'Gap', tone: 'warn', opens: 'today' },
		])
		expect(
			readExtensionRow({
				...base,
				ui: { icon: 'ui/icon.svg', accent: 'green', pages: [], chips: [] },
			})?.ui,
		).toBeUndefined()
		expect(
			readExtensionRow({ ...base, background: { indicator: 'weird' } })?.background,
		).toBeUndefined()
	})
	it('a disclosure carries the licence words, the background lines and the pages line', () => {
		const d = readDisclosure({
			extensionId: 'com.example.a',
			publisher: { name: 'P', contact: 'c' },
			storage: { where: 'w', encryption: 'e', adminCanRead: false },
			permissions: [],
			licence: 'No licence needed.',
			background: {
				line: 'Starts when you sign in and keeps running when Namzu is closed.',
				whileClosed: 'It shows nothing of its own while Namzu is closed.',
				defaultOn: true,
			},
			pages:
				'This extension draws pages inside Namzu: Today (settings). They cannot use the network.',
		})
		expect(d?.licence).toBe('No licence needed.')
		expect(d?.background?.defaultOn).toBe(true)
		expect(d?.pages).toMatch(/draws pages/)
	})
})
