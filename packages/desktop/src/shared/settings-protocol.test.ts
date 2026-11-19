import { describe, expect, it } from 'vitest'
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
		notifyPermission: 'banner',
		notifyQuestion: 'banner',
		notifyTaskComplete: 'banner',
		notifyError: 'banner',
		notifyLongReplySeconds: 30,
		notificationSound: 'none',
		showConversationTabs: false,
		responseFont: 'match',
		transcriptTextSize: 'medium',
		transcriptWidth: 'narrow',
		motion: 'system',
		autoDismissPopups: true,
		lightCodeTheme: 'default',
		darkCodeTheme: 'default',
		codeFont: '',
		codeFontSize: 13,
		virtualizeConversations: true,
		runOnStartup: false,
		systemTray: true,
		keepAwakeAppOpen: false,
		keepAwakeWhileWorking: false,
		keepAwakeOnBattery: false,
		pauseOnMetered: true,
		quickEntryShortcut: 'Ctrl+Alt+N',
		dictationShortcut: 'ctrl-d',
		voiceShortcut: '',
		autoOpenFiles: true,
		browserCookies: 'conversation',
		openLinksInBrowser: true,
		lastSettingsSection: 'general',
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
		notifyPermission: 'banner',
		notifyQuestion: 'banner',
		notifyTaskComplete: 'banner',
		notifyError: 'banner',
		notifyLongReplySeconds: 30,
		notificationSound: 'none',
		showConversationTabs: false,
		responseFont: 'match',
		transcriptTextSize: 'medium',
		transcriptWidth: 'narrow',
		motion: 'system',
		autoDismissPopups: true,
		lightCodeTheme: 'default',
		darkCodeTheme: 'default',
		codeFont: '',
		codeFontSize: 13,
		virtualizeConversations: true,
		runOnStartup: false,
		systemTray: true,
		keepAwakeAppOpen: false,
		keepAwakeWhileWorking: false,
		keepAwakeOnBattery: false,
		pauseOnMetered: true,
		quickEntryShortcut: 'Ctrl+Alt+N',
		dictationShortcut: 'ctrl-d',
		voiceShortcut: '',
		autoOpenFiles: true,
		browserCookies: 'conversation',
		openLinksInBrowser: true,
		lastSettingsSection: 'general',
	})
})

it('knows the sections, the Desktop app one among them', () => {
	for (const section of [
		'general',
		'projects',
		'appearance',
		'updates',
		'speech',
		'about',
		'desktop',
		'terminal',
	])
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

it('names the notification defaults: every level a banner, 30 seconds, sound none', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toMatchObject({
		notifyPermission: 'banner',
		notifyQuestion: 'banner',
		notifyTaskComplete: 'banner',
		notifyError: 'banner',
		notifyLongReplySeconds: 30,
		notificationSound: 'none',
		showConversationTabs: false,
	})
	expect(desktopSettingsPatch({ notificationSound: 'system' })).toEqual({
		notificationSound: 'system',
	})
	expect(() => desktopSettingsPatch({ notifyTaskComplete: 'yes' })).toThrow()
	expect(() => desktopSettingsPatch({ notifyFinished: true })).toThrow('Unknown setting.')
	expect(storedDesktopSettings({ notificationSound: 'x', notifyError: 'off' })).toMatchObject({
		notificationSound: 'none',
		showConversationTabs: false,
		notifyError: 'off',
	})
})

it('remembers the section Settings was last on, and ignores anything that is not one', () => {
	expect(DEFAULT_DESKTOP_SETTINGS.lastSettingsSection).toBe('general')
	expect(desktopSettingsPatch({ lastSettingsSection: 'appearance' })).toEqual({
		lastSettingsSection: 'appearance',
	})
	expect(() => desktopSettingsPatch({ lastSettingsSection: 'plugins' })).toThrow()
	expect(storedDesktopSettings({ lastSettingsSection: 'about' }).lastSettingsSection).toBe('about')
	expect(storedDesktopSettings({ lastSettingsSection: 'desktop' }).lastSettingsSection).toBe(
		'desktop',
	)
	expect(desktopSettingsPatch({ lastSettingsSection: 'desktop' })).toEqual({
		lastSettingsSection: 'desktop',
	})
	expect(storedDesktopSettings({ lastSettingsSection: 'nope' }).lastSettingsSection).toBe('general')
})

it('the system rows default as documented and load as the default from a file saved before they existed', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toMatchObject({
		runOnStartup: false,
		systemTray: true,
		keepAwakeAppOpen: false,
		keepAwakeWhileWorking: false,
		keepAwakeOnBattery: false,
		pauseOnMetered: true,
		quickEntryShortcut: 'Ctrl+Alt+N',
		dictationShortcut: 'ctrl-d',
		voiceShortcut: '',
	})
	const older = storedDesktopSettings({ startup: 'home', hardwareAcceleration: false })
	expect(older.systemTray).toBe(true)
	expect(older.runOnStartup).toBe(false)
	expect(older.pauseOnMetered).toBe(true)
	expect(storedDesktopSettings({ systemTray: 'yes', keepAwakeAppOpen: 1 }).systemTray).toBe(true)
	expect(desktopSettingsPatch({ runOnStartup: true, keepAwakeOnBattery: true })).toEqual({
		runOnStartup: true,
		keepAwakeOnBattery: true,
	})
	expect(() => desktopSettingsPatch({ systemTray: 'on' })).toThrow()
})

it('shortcut settings migrate from absent and refuse text that is not a shortcut', () => {
	const older = storedDesktopSettings({ startup: 'home' })
	expect(older.quickEntryShortcut).toBe('Ctrl+Alt+N')
	expect(older.dictationShortcut).toBe('ctrl-d')
	expect(older.voiceShortcut).toBe('')
	expect(storedDesktopSettings({ quickEntryShortcut: 'Shift+A' }).quickEntryShortcut).toBe(
		'Ctrl+Alt+N',
	)
	expect(storedDesktopSettings({ quickEntryShortcut: '' }).quickEntryShortcut).toBe('')
	expect(storedDesktopSettings({ dictationShortcut: 'ctrl-q' }).dictationShortcut).toBe('ctrl-d')
	expect(desktopSettingsPatch({ voiceShortcut: 'Alt+F9', dictationShortcut: 'off' })).toEqual({
		voiceShortcut: 'Alt+F9',
		dictationShortcut: 'off',
	})
	expect(() => desktopSettingsPatch({ voiceShortcut: 'Ctrl+' })).toThrow()
})

describe('notifications saved as four switches', () => {
	it('loads a file from before the keys existed as the old defaults', () => {
		const settings = storedDesktopSettings({ startup: 'home' })
		expect(settings).toMatchObject({
			notifyPermission: 'banner',
			notifyQuestion: 'banner',
			notifyTaskComplete: 'banner',
			notifyError: 'banner',
			notifyLongReplySeconds: 30,
			notificationSound: 'none',
		})
	})

	it('maps an on switch to Banner and an off switch to Off', () => {
		const settings = storedDesktopSettings({
			notifyNeedsYou: true,
			notifyFailed: false,
			notifyFinished: false,
			notifySound: true,
		})
		expect(settings).toMatchObject({
			notifyPermission: 'banner',
			notifyQuestion: 'banner',
			notifyError: 'off',
			notifyTaskComplete: 'off',
			notificationSound: 'system',
		})
	})

	it('keeps the icon count of a person who only turned the banner off', () => {
		expect(storedDesktopSettings({ notifyNeedsYou: false }).notifyPermission).toBe('badge')
		expect(storedDesktopSettings({ notifyNeedsYou: false }).notifyQuestion).toBe('badge')
		expect(
			storedDesktopSettings({ notifyNeedsYou: false, attentionSignals: false }).notifyPermission,
		).toBe('off')
	})

	it('lets a saved new key win over an old switch, and rejects bad levels and times', () => {
		expect(
			storedDesktopSettings({ notifyNeedsYou: false, notifyPermission: 'banner' }).notifyPermission,
		).toBe('banner')
		expect(storedDesktopSettings({ notifyQuestion: 'loud' }).notifyQuestion).toBe('banner')
		expect(storedDesktopSettings({ notifyTaskComplete: 'badge' }).notifyTaskComplete).toBe('banner')
		expect(storedDesktopSettings({ notifyLongReplySeconds: 45 }).notifyLongReplySeconds).toBe(45)
		expect(storedDesktopSettings({ notifyLongReplySeconds: 2 }).notifyLongReplySeconds).toBe(30)
		expect(storedDesktopSettings({ notifyLongReplySeconds: 4000 }).notifyLongReplySeconds).toBe(30)
		expect(desktopSettingsPatch({ notifyQuestion: 'badge' })).toEqual({ notifyQuestion: 'badge' })
		expect(() => desktopSettingsPatch({ notifyError: 'badge' })).toThrow('Invalid setting value.')
		expect(() => desktopSettingsPatch({ notifyLongReplySeconds: 12.5 })).toThrow()
		expect(() => desktopSettingsPatch({ notificationSound: true })).toThrow()
	})
})

it('keeps the built-in browser rows: files that open by themselves, how long sign-ins last, where links go', () => {
	expect(DEFAULT_DESKTOP_SETTINGS).toMatchObject({
		autoOpenFiles: true,
		browserCookies: 'conversation',
		openLinksInBrowser: true,
	})
	expect(
		desktopSettingsPatch({
			autoOpenFiles: false,
			browserCookies: 'restarts',
			openLinksInBrowser: false,
		}),
	).toEqual({ autoOpenFiles: false, browserCookies: 'restarts', openLinksInBrowser: false })
	for (const scope of ['quit', 'restarts', 'conversation'])
		expect(desktopSettingsPatch({ browserCookies: scope })).toEqual({ browserCookies: scope })
	for (const bad of [
		{ browserCookies: 'forever' },
		{ autoOpenFiles: 'yes' },
		{ openLinksInBrowser: 1 },
	])
		expect(() => desktopSettingsPatch(bad)).toThrow('Invalid setting value.')
	expect(storedDesktopSettings({ browserCookies: 'forever', autoOpenFiles: 'no' })).toMatchObject({
		browserCookies: 'conversation',
		autoOpenFiles: true,
	})
})

it("keeps each conversation's sign-ins apart until the person picks another scope", () => {
	expect(DEFAULT_DESKTOP_SETTINGS.browserCookies).toBe('conversation')
})
