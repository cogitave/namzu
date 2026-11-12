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
		{ keepEngineUpToDate: 'yes' },
		{ terminalShell: 'zsh' },
		{ restoreTerminals: 'yes' },
		{ voiceInputAccepted: 'yes' },
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
			keepEngineUpToDate: true,
			future: 'x',
		}),
	).toEqual({
		startup: 'home',
		retrustOnConfigChange: true,
		autoDownloadUpdates: false,
		keepEngineUpToDate: true,
		terminalShell: 'auto',
		restoreTerminals: true,
		voiceInputAccepted: false,
		hardwareAcceleration: true,
		attentionSignals: true,
		notifyNeedsYou: true,
		notifyFailed: true,
		notifyFinished: true,
		notifySound: false,
		showConversationTabs: false,
	})
})

it('documents the defaults the spec names', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toEqual({
		startup: 'continue',
		retrustOnConfigChange: true,
		autoDownloadUpdates: true,
		keepEngineUpToDate: true,
		terminalShell: 'auto',
		restoreTerminals: true,
		voiceInputAccepted: false,
		hardwareAcceleration: true,
		attentionSignals: true,
		notifyNeedsYou: true,
		notifyFailed: true,
		notifyFinished: true,
		notifySound: false,
		showConversationTabs: false,
	})
})

it('knows the six sections', () => {
	for (const section of ['general', 'projects', 'appearance', 'updates', 'speech', 'about'])
		expect(isSettingsSection(section)).toBe(true)
	expect(isSettingsSection('plugins')).toBe(false)
	expect(isSettingsSection(undefined)).toBe(false)
})

it('voice input is not agreed to until the person says so, and only a boolean says it', () => {
	expect(DEFAULT_DESKTOP_SETTINGS.voiceInputAccepted).toBe(false)
	expect(desktopSettingsPatch({ voiceInputAccepted: true })).toEqual({ voiceInputAccepted: true })
	expect(storedDesktopSettings({ voiceInputAccepted: true }).voiceInputAccepted).toBe(true)
	expect(storedDesktopSettings({ voiceInputAccepted: 'true' }).voiceInputAccepted).toBe(false)
})

it('turns the attention signals on by default and round trips the choice', () => {
	expect(DEFAULT_DESKTOP_SETTINGS.attentionSignals).toBe(true)
	expect(desktopSettingsPatch({ attentionSignals: false })).toEqual({ attentionSignals: false })
	expect(() => desktopSettingsPatch({ attentionSignals: 'no' })).toThrow()
	expect(storedDesktopSettings({ attentionSignals: false }).attentionSignals).toBe(false)
	expect(storedDesktopSettings({ attentionSignals: 'x' }).attentionSignals).toBe(true)
})

it('names the notification defaults: needs you, failed and finished on, sound off', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toMatchObject({
		notifyNeedsYou: true,
		notifyFailed: true,
		notifyFinished: true,
		notifySound: false,
		showConversationTabs: false,
	})
	expect(desktopSettingsPatch({ notifySound: true })).toEqual({ notifySound: true })
	expect(() => desktopSettingsPatch({ notifyFinished: 'yes' })).toThrow()
	expect(storedDesktopSettings({ notifySound: 'x', notifyFailed: false })).toMatchObject({
		notifySound: false,
		showConversationTabs: false,
		notifyFailed: false,
	})
})
