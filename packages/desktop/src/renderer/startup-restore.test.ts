import { afterEach, describe, expect, it } from 'vitest'
import type { DesktopBoot } from '../shared/protocol.js'
import { adoptBoot, launchSeed, restoreDecision, settleLaunchSeed } from './startup-restore.js'

const base = {
	startupHome: false,
	activeTabId: 'tab',
	restoring: true,
	failed: false,
}

describe('restoreDecision', () => {
	it('restores while a saved tab is coming back, whatever its folder is doing', () => {
		expect(restoreDecision(base)).toBe('restore')
		expect(restoreDecision({ ...base, tabProject: { status: 'connecting', trusted: false } })).toBe(
			'restore',
		)
		expect(restoreDecision({ ...base, tabProject: { status: 'ready', trusted: true } })).toBe(
			'restore',
		)
	})
	it('shows home when the person chose to start there', () => {
		expect(restoreDecision({ ...base, startupHome: true })).toBe('home')
	})
	it('shows home when there is nothing to restore or the restore is over', () => {
		expect(restoreDecision({ ...base, activeTabId: '' })).toBe('home')
		expect(restoreDecision({ ...base, restoring: false })).toBe('home')
	})
	it('lets the ordinary screens explain a restore that cannot finish', () => {
		expect(restoreDecision({ ...base, failed: true })).toBe('home')
		expect(restoreDecision({ ...base, tabProject: { status: 'error', trusted: true } })).toBe(
			'home',
		)
		expect(restoreDecision({ ...base, tabProject: { status: 'ready', trusted: false } })).toBe(
			'home',
		)
	})
})

describe('launch seed', () => {
	afterEach(() => adoptBoot(undefined))
	const boot = (launch: boolean): DesktopBoot => ({
		launch,
		settings: {
			startup: 'continue',
			retrustOnConfigChange: true,
			autoDownloadUpdates: true,
			terminalShell: 'auto',
			restoreTerminals: true,
		},
		workspace: {} as DesktopBoot['workspace'],
		projects: [],
		conversations: [],
	})
	it('is available to the launch commit only, once settled it is gone', () => {
		adoptBoot(boot(true))
		expect(launchSeed()).toBeDefined()
		expect(launchSeed()).toBeDefined() // StrictMode renders twice
		settleLaunchSeed()
		expect(launchSeed()).toBeUndefined()
	})
	it('is never offered to a window that did not launch with the app', () => {
		adoptBoot(boot(false))
		expect(launchSeed()).toBeUndefined()
		adoptBoot(undefined)
		expect(launchSeed()).toBeUndefined()
	})
})
