import { describe, expect, it } from 'vitest'
import type { ProjectView } from '../shared/protocol.js'
import {
	FINISHED_NOTICE_AFTER_MS,
	SETTINGS_SECTIONS,
	isSettingsSection,
} from '../shared/settings-protocol.js'
import {
	ENGINE_ONLY_SECTIONS,
	SETTINGS_ENTRIES,
	SETTINGS_NAV_GROUPS,
	SETTINGS_SECTION_TITLES,
	aboutDetailsText,
	entryIsDrawn,
	lastCheckedText,
	parseSettingsRoute,
	platformText,
	projectRemovalCopy,
	projectTrustText,
	removalNotice,
	searchSettings,
	settingsRoute,
	updateStatusView,
	visibleNavGroups,
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

	it('finds a Turkish word typed with a capital İ or a dotless ı, and a lone İ is not a word', () => {
		expect(searchSettings('TERMİNAL').map((e) => e.id)).toContain('terminal-shell')
		expect(searchSettings('termınal').map((e) => e.id)).toContain('terminal-shell')
		expect(searchSettings('THEMİ')).toEqual([])
		const entries = [
			{ id: 'a', section: 'general', label: 'Işık ve ŞEKİL', description: 'x' },
		] as const
		expect(searchSettings('isik sekil', entries).map((e) => e.id)).toEqual(['a'])
		expect(searchSettings('ŞEKİL', entries).map((e) => e.id)).toEqual(['a'])
	})

	it('finds rows by the reference words as well as Namzu\u2019s own', () => {
		expect(searchSettings('chat font')[0]?.id).toBe('interface-font')
		expect(searchSettings('ui font')[0]?.id).toBe('interface-font')
		expect(searchSettings('text size').map((e) => e.id)).toContain('interface-font')
		expect(searchSettings('startup').map((e) => e.id)).toContain('startup')
		expect(searchSettings('tray').map((e) => e.id)).toContain('attention-signals')
		expect(searchSettings('graphics card').map((e) => e.id)).toContain('hardware-acceleration')
		expect(searchSettings('graphics card')[0]?.section).toBe('desktop')
		expect(searchSettings('keep the engine').map((e) => e.id)).toContain('keep-engine')
	})

	it('has a unique id for every entry and a real section for each', () => {
		const ids = SETTINGS_ENTRIES.map((e) => e.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const entry of SETTINGS_ENTRIES)
			expect(SETTINGS_SECTION_TITLES[entry.section]).toBeTruthy()
		for (const section of SETTINGS_SECTIONS.filter((s) => !ENGINE_ONLY_SECTIONS.includes(s)))
			expect(SETTINGS_ENTRIES.some((e) => e.section === section)).toBe(true)
	})
})

describe('where the Desktop rows sit', () => {
	const sectionOf = (id: string) => SETTINGS_ENTRIES.find((entry) => entry.id === id)?.section
	it('keeps each moved row in its new section, and a search hit names that section', () => {
		expect(sectionOf('hardware-acceleration')).toBe('desktop')
		expect(sectionOf('terminal-shell')).toBe('terminal')
		expect(sectionOf('terminal-restore')).toBe('terminal')
		expect(searchSettings('shell')[0]?.section).toBe('terminal')
		expect(searchSettings('bring terminal tabs back')[0]?.section).toBe('terminal')
		// Notifications stay in General until they have a section of their own.
		for (const id of ['notify-needs-you', 'notify-failed', 'notify-finished', 'notify-sound'])
			expect(sectionOf(id)).toBe('general')
	})

	it('has a Desktop app section in the fourth group, first, and it is a valid stored section', () => {
		expect(SETTINGS_NAV_GROUPS[3]).toEqual(['desktop', 'telemetry', 'updates', 'about'])
		expect(SETTINGS_SECTION_TITLES.desktop).toBe('Desktop app')
		expect(isSettingsSection('desktop')).toBe(true)
		expect(parseSettingsRoute('settings/desktop')).toBe('desktop')
		// A section stored before the move still opens.
		for (const old of ['general', 'models', 'agent', 'tools', 'projects', 'appearance', 'terminal'])
			expect(isSettingsSection(old)).toBe(true)
	})

	it('draws the shell row only where main offers a choice, which is Windows, and search follows', () => {
		const facts = { hasAppUpdater: true, canFetchEngines: true }
		// Linux and macOS: main answers with the login shell alone.
		expect(entryIsDrawn('terminal-shell', { ...facts, shells: [{ value: 'auto' }] })).toBe(false)
		// Still being asked.
		expect(entryIsDrawn('terminal-shell', { ...facts, shells: undefined })).toBe(false)
		// No terminals at all.
		expect(entryIsDrawn('terminal-shell', { ...facts, shells: null })).toBe(false)
		expect(entryIsDrawn('terminal-restore', { ...facts, shells: null })).toBe(false)
		// Windows: Automatic and at least Command Prompt.
		const windows = { ...facts, shells: [{ value: 'auto' }, { value: 'cmd' }] }
		expect(entryIsDrawn('terminal-shell', windows)).toBe(true)
		expect(entryIsDrawn('terminal-restore', { ...facts, shells: [{ value: 'auto' }] })).toBe(true)
		expect(entryIsDrawn('auto-download', { ...windows, hasAppUpdater: false })).toBe(false)
		expect(entryIsDrawn('keep-engine', { ...windows, canFetchEngines: false })).toBe(false)
		expect(entryIsDrawn('cfg-disableHooks', windows)).toBe(false)
		expect(entryIsDrawn('theme', windows)).toBe(true)
		// The row's own words say where it works.
		expect(SETTINGS_ENTRIES.find((entry) => entry.id === 'terminal-shell')?.description).toMatch(
			/^Windows only\./,
		)
	})
})

describe('about', () => {
	it('says the system in words and copies versions, not paths', () => {
		expect(platformText('win32 x64')).toBe('Windows (64-bit Intel or AMD)')
		expect(platformText('darwin arm64')).toBe('macOS (ARM)')
		expect(platformText('linux x64')).toBe('Linux (64-bit Intel or AMD)')
		expect(platformText('')).toBe('Unknown')
		expect(
			aboutDetailsText({ version: '0.1.0', cliVersion: '35.0.0', platform: 'linux x64' }),
		).toBe(
			[
				'Namzu Desktop 0.1.0',
				'Namzu command line (bundled with this app) 35.0.0',
				'Namzu engine not found',
				'Linux (64-bit Intel or AMD)',
			].join('\n'),
		)
	})
})

describe('the details a person copies', () => {
	it('carry the same newer-kernel facts as About, and no more', () => {
		const info = {
			version: '0.5.0',
			cliVersion: '49.1.1',
			sdkVersion: '62.6.1',
			platform: 'linux x64',
		}
		expect(aboutDetailsText(info, { cli: '51.0.1', engine: '62.12.0' })).toBe(
			[
				'Namzu Desktop 0.5.0',
				'Namzu command line (bundled with this app) 49.1.1',
				'A newer command line exists (51.0.1); it arrives with an update of this app',
				'Namzu engine 62.6.1',
				'A newer engine exists (62.12.0); it arrives with an update of this app',
				'Linux (64-bit Intel or AMD)',
			].join('\n'),
		)
		expect(aboutDetailsText(info, {})).toBe(aboutDetailsText(info))
		expect(aboutDetailsText(info)).not.toContain('newer')
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

	it('names the project and says trust goes with it', () => {
		const copy = projectRemovalCopy({ name: 'App' })
		expect(copy.title).toBe('Remove \u201cApp\u201d from Namzu?')
		expect(copy.description).toContain('\u201cApp\u201d')
		expect(copy.description).toContain('off Namzu\u2019s trusted list')
		expect(copy.description).toContain('forgets what this app recorded about it')
		expect(copy.description).toContain('asks again if you add it back')
		expect(copy.description).toContain(
			'Files on your computer and existing conversations won\u2019t be deleted',
		)
		expect([copy.actionLabel, copy.pendingLabel]).toEqual(['Remove project', 'Removing\u2026'])
	})

	it('words a missing folder without promising a trust change', () => {
		const copy = projectRemovalCopy({ name: 'App', missing: true })
		expect(copy.description).toContain('can\u2019t find the folder')
		expect(copy.description).not.toContain('trusted list')
	})

	it('is honest about a folder that stays trusted', () => {
		expect(removalNotice('App', { state: 'removed' })).toBe(
			'Removed \u201cApp\u201d. Namzu no longer trusts the folder.',
		)
		expect(removalNotice('App', { state: 'still-trusted', by: '/home/me' })).toBe(
			'Removed \u201cApp\u201d. The folder is still trusted through /home/me.',
		)
		expect(removalNotice('App', { state: 'still-trusted', by: '' })).toContain('a parent folder')
		expect(removalNotice('App', { state: 'not-connected' })).toContain('wasn’t connected')
		expect(removalNotice('App', { state: 'unsupported' })).toContain('stays trusted')
	})
})

describe('attention setting search', () => {
	it('is found by badge, taskbar and flash', () => {
		for (const word of ['badge', 'taskbar', 'flash'])
			expect(searchSettings(word).map((entry) => entry.id)).toContain('attention-signals')
	})
})

describe('notification setting search', () => {
	it('finds each notification switch by plain words', () => {
		const find = (word: string) => searchSettings(word).map((entry) => entry.id)
		expect(find('notification')).toEqual(
			expect.arrayContaining([
				'notify-needs-you',
				'notify-failed',
				'notify-finished',
				'notify-sound',
			]),
		)
		expect(find('banner')).toContain('notify-needs-you')
		expect(find('chime')).toContain('notify-sound')
		expect(find('done')).toContain('notify-finished')
	})
})

describe('finished notification wording', () => {
	it('names the same threshold the main process uses, and says "or more"', () => {
		const entry = searchSettings('done').find((item) => item.id === 'notify-finished')
		expect(entry?.description).toContain(`${FINISHED_NOTICE_AFTER_MS / 1000} seconds or more`)
	})
})

describe('the left column groups', () => {
	it('lists every section exactly once, in four groups', () => {
		expect(SETTINGS_NAV_GROUPS).toHaveLength(4)
		expect([...SETTINGS_NAV_GROUPS.flat()].sort()).toEqual([...SETTINGS_SECTIONS].sort())
	})

	it('keeps whole groups with no search and only the matching sections with one', () => {
		expect(visibleNavGroups(undefined)).toEqual(SETTINGS_NAV_GROUPS)
		expect(visibleNavGroups([{ section: 'speech' }, { section: 'models' }])).toEqual([
			['models'],
			['speech'],
		])
		expect(visibleNavGroups([])).toEqual([])
	})
})
