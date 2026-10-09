import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import { SETTINGS_SECTIONS } from '../shared/settings-protocol.js'
import {
	SETTINGS_ENTRIES,
	SETTINGS_SECTION_TITLES,
	lastCheckedText,
	parseSettingsRoute,
	projectRemovalCopy,
	projectTrustText,
	removalNotice,
	searchSettings,
	settingsRoute,
	updateStatusView,
} from './settings-model.js'

describe('deep links', () => {
	it('round-trips every section and rejects anything else', () => {
		for (const section of SETTINGS_SECTIONS)
			expect(parseSettingsRoute(settingsRoute(section))).toBe(section)
		expect(parseSettingsRoute('settings')).toBe('general')
		expect(parseSettingsRoute('settings/')).toBe('general')
		for (const bad of ['plugins/general', 'settings/nope', 'settings/general/extra', ''])
			expect(parseSettingsRoute(bad)).toBeUndefined()
	})
})

describe('search', () => {
	it('finds a setting by its label, a description word or a keyword', () => {
		expect(searchSettings('theme')[0]?.id).toBe('theme')
		expect(searchSettings('dark').map((e) => e.id)).toContain('theme')
		expect(searchSettings('startup').map((e) => e.id)).toEqual(['startup'])
		expect(searchSettings('restore').map((e) => e.id)).toContain('startup')
	})

	it('requires every word and ranks a label match above a description match', () => {
		expect(searchSettings('download updates').map((e) => e.id)[0]).toBe('auto-download')
		expect(searchSettings('theme nonsense')).toEqual([])
		// 'updates' is in the label of both update rows and only in a keyword of the others.
		const ranked = searchSettings('updates').map((e) => e.id)
		expect(ranked.slice(0, 2).sort()).toEqual(['auto-download', 'version'])
	})

	it('is empty for a blank query and ignores case and punctuation', () => {
		expect(searchSettings('')).toEqual([])
		expect(searchSettings('   ')).toEqual([])
		expect(searchSettings('  THEME!! ').map((e) => e.id)).toEqual(['theme'])
	})

	it('has a unique id for every entry and a real section for each', () => {
		const ids = SETTINGS_ENTRIES.map((e) => e.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const entry of SETTINGS_ENTRIES)
			expect(SETTINGS_SECTION_TITLES[entry.section]).toBeTruthy()
		for (const section of SETTINGS_SECTIONS)
			expect(SETTINGS_ENTRIES.some((e) => e.section === section)).toBe(true)
	})
})

describe('updates', () => {
	it('words the last check from an injected clock', () => {
		const now = 10_000_000
		expect(lastCheckedText(undefined, now)).toBe('Not checked yet')
		expect(lastCheckedText(now - 5_000, now)).toBe('Just now')
		expect(lastCheckedText(now - 60_000, now)).toBe('1 minute ago')
		expect(lastCheckedText(now - 5 * 60_000, now)).toBe('5 minutes ago')
		expect(lastCheckedText(now - 3 * 3_600_000, now)).toBe('3 hours ago')
		expect(lastCheckedText(now - 26 * 3_600_000, now)).toBe('1 day ago')
		expect(lastCheckedText(now + 9_000, now)).toBe('Just now')
	})

	it('offers one button per state and a check only when one is useful', () => {
		expect(updateStatusView({ status: 'disabled' })).toMatchObject({
			canCheck: false,
			text: 'This copy can’t update itself. Install the latest version once to turn updates on.',
		})
		expect(updateStatusView({ status: 'idle' })).toMatchObject({ action: 'check', canCheck: true })
		expect(updateStatusView({ status: 'checking' })).toMatchObject({ canCheck: false })
		expect(updateStatusView({ status: 'available', version: '2.0.0' })).toMatchObject({
			action: 'download',
			canCheck: false,
			text: 'Update available: version 2.0.0.',
		})
		expect(
			updateStatusView({ status: 'downloading', percent: 40, bytesPerSecond: 0 }).text,
		).toContain('40%')
		expect(updateStatusView({ status: 'ready', version: '2.0.0' })).toMatchObject({
			action: 'restart',
		})
		expect(updateStatusView({ status: 'error', message: 'x' })).toMatchObject({
			action: 'check',
			canCheck: true,
		})
	})
})

describe('projects', () => {
	const project = (over: Partial<ProjectView>): ProjectView => ({
		id: 'p',
		path: '/p',
		name: 'App',
		trusted: true,
		status: 'ready',
		...over,
	})
	it('says what state each project is in', () => {
		expect(projectTrustText(project({}))).toBe('Trusted')
		expect(projectTrustText(project({ trusted: false }))).toBe('Not trusted yet')
		expect(projectTrustText(project({ status: 'connecting' }))).toBe('Connecting')
		expect(projectTrustText(project({ status: 'error' }))).toBe('Needs reconnecting')
	})

	it('words the confirmation exactly as the spec does', () => {
		expect(projectRemovalCopy({ name: 'App' })).toEqual({
			title: 'Remove App?',
			description:
				'This only removes the project from Namzu. Files on your computer and existing conversations won’t be deleted.',
			actionLabel: 'Remove project',
			pendingLabel: 'Removing…',
		})
	})

	it('is honest about a folder that stays trusted', () => {
		expect(removalNotice('App', { state: 'removed' })).toBe('Removed App.')
		expect(removalNotice('App', { state: 'still-trusted', by: '/home/me' })).toBe(
			'Removed App. The folder is still trusted through /home/me.',
		)
		expect(removalNotice('App', { state: 'still-trusted', by: '' })).toContain('a parent folder')
		expect(removalNotice('App', { state: 'not-connected' })).toContain('wasn’t connected')
		expect(removalNotice('App', { state: 'unsupported' })).toContain('stays trusted')
	})
})
