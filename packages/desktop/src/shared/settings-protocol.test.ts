import { expect, it } from 'vitest'
import {
	DEFAULT_DESKTOP_SETTINGS,
	desktopSettingsPatch,
	isSettingsSection,
	storedDesktopSettings,
} from './settings-protocol.js'

it('accepts only known keys with valid values in a change', () => {
	expect(desktopSettingsPatch({})).toEqual({})
	expect(desktopSettingsPatch({ startup: 'home', retrustOnConfigChange: false })).toEqual({
		startup: 'home',
		retrustOnConfigChange: false,
	})
	for (const bad of [
		undefined,
		null,
		[],
		'home',
		{ startup: 'HOME' },
		{ startup: true },
		{ autoDownloadUpdates: 'true' },
		{ unknown: 1 },
		{ __proto__: { startup: 'home' }, constructor: 1 },
	])
		expect(() => desktopSettingsPatch(bad)).toThrow()
})

it('reads a stored file entry by entry and ignores what it does not know', () => {
	expect(storedDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS)
	expect(storedDesktopSettings([])).toEqual(DEFAULT_DESKTOP_SETTINGS)
	expect(
		storedDesktopSettings({
			version: 1,
			startup: 'home',
			retrustOnConfigChange: 0,
			autoDownloadUpdates: false,
			future: 'x',
		}),
	).toEqual({ startup: 'home', retrustOnConfigChange: true, autoDownloadUpdates: false })
})

it('documents the defaults the spec names', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toEqual({
		startup: 'continue',
		retrustOnConfigChange: true,
		autoDownloadUpdates: true,
	})
})

it('knows the six sections', () => {
	for (const section of ['general', 'projects', 'appearance', 'updates', 'speech', 'about'])
		expect(isSettingsSection(section)).toBe(true)
	expect(isSettingsSection('plugins')).toBe(false)
	expect(isSettingsSection(undefined)).toBe(false)
})
