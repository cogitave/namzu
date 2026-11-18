import { describe, expect, it } from 'vitest'
import { catalogueAccepts, catalogueEntry, isSafeFontName } from './settings-catalogue.js'
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopSettings,
	desktopSettingsPatch,
	storedDesktopSettings,
} from './settings-protocol.js'

/** The Appearance values part A owns: key, row id, default, a valid non-default value, an invalid one. */
const ROWS: {
	key: keyof DesktopSettings
	id: string
	fallback: unknown
	other: unknown
	bad: unknown
}[] = [
	{ key: 'responseFont', id: 'response-font', fallback: 'match', other: 'Georgia', bad: 'a"b;c' },
	{
		key: 'transcriptTextSize',
		id: 'transcript-text-size',
		fallback: 'medium',
		other: 'large',
		bad: 'huge',
	},
	{
		key: 'transcriptWidth',
		id: 'transcript-width',
		fallback: 'narrow',
		other: 'wide',
		bad: 'full',
	},
	{ key: 'motion', id: 'motion', fallback: 'system', other: 'reduce', bad: 'none' },
	{ key: 'autoDismissPopups', id: 'auto-dismiss-popups', fallback: true, other: false, bad: 'no' },
	{
		key: 'virtualizeConversations',
		id: 'virtualize-conversations',
		fallback: true,
		other: false,
		bad: 1,
	},
]

describe('the Appearance settings', () => {
	for (const row of ROWS) {
		describe(row.key, () => {
			it('has a catalogue row in Appearance and the typed default', () => {
				const entry = catalogueEntry(row.id)
				expect(entry.section).toBe('appearance')
				expect(entry.key).toBe(row.key)
				expect(entry.default).toBe(row.fallback)
				expect(DEFAULT_DESKTOP_SETTINGS[row.key]).toBe(row.fallback)
			})

			it('is stored when valid, and falls back when the stored value is bad', () => {
				expect(storedDesktopSettings({ [row.key]: row.other })[row.key]).toBe(row.other)
				expect(storedDesktopSettings({ [row.key]: row.bad })[row.key]).toBe(row.fallback)
			})

			it('loads from a file written before it existed, and leaves the other values as they were', () => {
				const old = storedDesktopSettings({ startup: 'home', notifySound: true })
				expect(old[row.key]).toBe(row.fallback)
				expect(old.startup).toBe('home')
				expect(old.notifySound).toBe(true)
			})

			it('is accepted in a change request only when valid', () => {
				expect(desktopSettingsPatch({ [row.key]: row.other })).toEqual({ [row.key]: row.other })
				expect(() => desktopSettingsPatch({ [row.key]: row.bad })).toThrow('Invalid setting value.')
			})
		})
	}

	it('takes only names a font-family declaration can carry safely', () => {
		for (const name of [
			'Inter',
			'IBM Plex Sans',
			'Noto Sans (Display)',
			'Fira Code-Retina',
			'Söhne',
		])
			expect(isSafeFontName(name), name).toBe(true)
		for (const name of ['', 'a"b', 'a;b', 'a{b}', 'a\\b', 'a<b>', 'a\nb', 'x'.repeat(81)])
			expect(isSafeFontName(name), name).toBe(false)
	})

	it('holds a font name in a text control, empty or up to its length', () => {
		const entry = catalogueEntry('response-font')
		expect(catalogueAccepts(entry, 'system')).toBe(true)
		expect(catalogueAccepts(entry, 'x'.repeat(81))).toBe(false)
		expect(catalogueAccepts(entry, 4)).toBe(false)
	})

	it('describes every row so search and deep links find it', () => {
		for (const row of ROWS) {
			const entry = catalogueEntry(row.id)
			expect(entry.label.length).toBeGreaterThan(0)
			expect(entry.keywords?.length ?? 0).toBeGreaterThan(0)
			expect(entry.hidden).toBeUndefined()
		}
	})

	it('has Narrow as today’s width and Medium as today’s text size', () => {
		expect(DEFAULT_DESKTOP_SETTINGS.transcriptWidth).toBe('narrow')
		expect(DEFAULT_DESKTOP_SETTINGS.transcriptTextSize).toBe('medium')
	})
})
