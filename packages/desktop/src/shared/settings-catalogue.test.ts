import { describe, expect, it } from 'vitest'

import {
	CATALOGUE_APPLIES_TEXT,
	DESKTOP_KEYED_ENTRIES,
	SETTINGS_CATALOGUE,
	appliesText,
	catalogueAccepts,
	catalogueEntry,
} from './settings-catalogue.js'
import {
	DEFAULT_DESKTOP_SETTINGS,
	SETTINGS_SECTIONS,
	desktopSettingsPatch,
	storedDesktopSettings,
} from './settings-protocol.js'

describe('the Desktop settings catalogue', () => {
	it('has one entry per id, in a real section, with a label, a description and an apply time', () => {
		const ids = SETTINGS_CATALOGUE.map((entry) => entry.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const entry of SETTINGS_CATALOGUE) {
			expect(SETTINGS_SECTIONS).toContain(entry.section)
			expect(entry.label.trim()).not.toBe('')
			expect(entry.description.trim()).not.toBe('')
			expect(Object.keys(CATALOGUE_APPLIES_TEXT)).toContain(entry.appliesWhen)
			expect(appliesText(entry)).not.toBe('')
		}
	})

	it('gives every saved key a typed default its control accepts', () => {
		const keys = DESKTOP_KEYED_ENTRIES.map((entry) => entry.key)
		expect(new Set(keys).size).toBe(keys.length)
		for (const entry of DESKTOP_KEYED_ENTRIES) {
			expect(entry.default, entry.key).not.toBeUndefined()
			expect(catalogueAccepts(entry, entry.default), entry.key).toBe(true)
			expect(DEFAULT_DESKTOP_SETTINGS[entry.key]).toBe(entry.default)
		}
	})

	it('is the only validator: a key is known because it is catalogued, a value is valid because its control holds it', () => {
		expect(desktopSettingsPatch({ startup: 'home', notificationSound: 'system' })).toEqual({
			startup: 'home',
			notificationSound: 'system',
		})
		expect(() => desktopSettingsPatch({ startup: 'later' })).toThrow('Invalid setting value.')
		expect(() => desktopSettingsPatch({ notificationSound: 'yes' })).toThrow(
			'Invalid setting value.',
		)
		expect(() => desktopSettingsPatch({ nope: true })).toThrow('Unknown setting.')
		expect(() => desktopSettingsPatch({ terminalShell: 'zsh' })).toThrow('Invalid setting value.')
		expect(desktopSettingsPatch({ terminalShell: 'wsl' })).toEqual({ terminalShell: 'wsl' })
	})

	it('falls back to the catalogue default for a bad or missing stored value', () => {
		expect(storedDesktopSettings({ startup: 'x', hardwareAcceleration: false })).toEqual({
			...DEFAULT_DESKTOP_SETTINGS,
			hardwareAcceleration: false,
		})
	})

	it('says its own apply time in words, and what the plain words would get wrong', () => {
		expect(appliesText(catalogueEntry('hardware-acceleration'))).toBe(
			'Applies the next time the app opens.',
		)
		expect(appliesText(catalogueEntry('notify-sound'))).toBe('Applies at once.')
		expect(appliesText(catalogueEntry('terminal-shell'))).toMatch(/new terminal tabs/)
	})

	it('finds the settings by the words a person from another app would type', () => {
		const has = (id: string, word: string) =>
			expect(catalogueEntry(id).keywords, `${id} ${word}`).toContain(word)
		has('interface-font', 'ui font')
		has('interface-font', 'chat font')
		has('interface-font', 'text size')
		has('startup', 'startup')
		has('attention-signals', 'tray')
	})

	it('says Locate asks to trust the new folder', () => {
		expect(catalogueEntry('projects').description).toMatch(/Locate .* trust/)
	})
})

describe('renamed rows', () => {
	it('stay findable by the name they had', async () => {
		const { searchSettings } = await import('../renderer/settings-model.js')
		const found = (query: string) => searchSettings(query).map((entry) => entry.id)
		expect(found('Use the graphics card')).toContain('hardware-acceleration')
		expect(found('Bring terminal tabs back')).toContain('terminal-restore')
		expect(found('Skip drawing what is off screen')).toContain('virtualize-conversations')
		expect(found('Light code colours')).toContain('code-theme-light')
		expect(found('Close popups by themselves')).toContain('auto-dismiss-popups')
	})

	it('say nothing about when a change applies for a row that applies at once', () => {
		expect(appliesText(catalogueEntry('trusted-folders'))).toBe('Applies at once.')
		expect(catalogueEntry('trusted-folders').appliesNote).toBeUndefined()
	})
})
