import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LocalSpeechState } from '../shared/local-speech-protocol.js'
import type { ProjectView } from '../shared/protocol.js'
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopInfo,
	SETTINGS_SECTIONS,
	type SettingsSection,
} from '../shared/settings-protocol.js'
import { SettingsPage, type SettingsPageProps, SettingsSidebar } from './settings-page.js'
import type { LocalSpeechControls } from './use-local-speech.js'

const speechState = (
	installation: LocalSpeechState['installation'] = 'ready',
): LocalSpeechState => ({
	settings: { enabled: true, language: 'tr', engine: 'ema-lightning', idleUnloadSeconds: 300 },
	installation,
	worker: 'unloaded',
	device: 'cpu',
	resources: {
		modelDownloadBytes: 34_389_147,
		runtimeDownloadBytes: null,
		diskBytes: 500_000_000,
		ramBytes: null,
		cpuPercent: null,
		vramBytes: null,
		firstAudioMs: null,
		measuredAt: null,
	},
})
const speech = (installation?: LocalSpeechState['installation']): LocalSpeechControls => ({
	state: speechState(installation),
	supported: true,
	loading: false,
	busy: false,
	configure: vi.fn(),
	install: vi.fn(),
	uninstall: vi.fn(),
	preview: vi.fn(),
	readAloud: vi.fn(),
	stop: vi.fn(),
})
const project = (over: Partial<ProjectView>): ProjectView => ({
	id: 'p1',
	path: '/work/app',
	name: 'App',
	trusted: true,
	status: 'ready',
	...over,
})
const info: DesktopInfo = {
	version: '0.1.0',
	cliVersion: '25.3.0',
	sdkVersion: '25.2.1',
	platform: 'win32 x64',
	folders: [
		{ kind: 'app', label: 'Desktop app data', path: 'C:/Users/me/AppData/Roaming/Namzu' },
		{
			kind: 'speech',
			label: 'Downloaded voice',
			path: 'C:/Users/me/AppData/Roaming/Namzu/local-speech',
		},
	],
	notices: 'Third-party notices text',
}

/** Whether the input carrying this value is checked, whatever order the attributes print in. */
const isChecked = (markup: string, value: string) =>
	(markup.match(/<input[^>]*>/g) ?? []).some(
		(tag) => tag.includes(`value="${value}"`) && tag.includes('checked=""'),
	)

function page(section: SettingsSection, over: Partial<SettingsPageProps> = {}) {
	return renderToStaticMarkup(
		createElement(SettingsPage, {
			section,
			onSection: () => {},
			settings: {
				settings: { ...DEFAULT_DESKTOP_SETTINGS },
				error: '',
				change: async () => {},
				confirmation: undefined,
				confirm: async () => {},
				dismiss: () => {},
			},
			appearance: 'dark',
			onAppearanceChange: () => {},
			projects: [
				project({}),
				project({ id: 'p2', name: 'Docs', path: '/work/docs', trusted: false }),
			],
			onRemoveProject: () => {},
			update: {
				state: { status: 'idle' },
				info: { currentVersion: '0.1.0', lastCheckedAt: 1_000 },
				onOpen: () => {},
				onCheck: () => {},
			},
			speech: speech(),
			info,
			onOpenFolder: () => {},
			now: 1_000 + 5 * 60_000,
			...over,
		}),
	)
}

describe('the settings page', () => {
	it('is a labelled region with one h1, a search field and the section as h2', () => {
		for (const section of SETTINGS_SECTIONS) {
			const markup = page(section)
			expect(markup).toContain('aria-label="Settings"')
			expect(markup.match(/<h1>/g)).toHaveLength(1)
			expect(markup).toContain('aria-label="Search settings"')
			expect(markup.match(/<h2 class="settings-section-title">/g)).toHaveLength(1)
		}
	})

	it('General offers both startup choices, with the default selected', () => {
		const markup = page('general')
		expect(markup).toContain('Continue where I left off')
		expect(markup).toContain('Start on the home screen')
		expect(isChecked(markup, 'continue')).toBe(true)
		expect(isChecked(markup, 'home')).toBe(false)
		const home = page('general', {
			settings: {
				settings: { ...DEFAULT_DESKTOP_SETTINGS, startup: 'home' },
				error: '',
				change: async () => {},
				confirmation: undefined,
				confirm: async () => {},
				dismiss: () => {},
			},
		})
		expect(isChecked(home, 'home')).toBe(true)
		expect(isChecked(home, 'continue')).toBe(false)
	})

	it('Projects lists name, path, trust state and a Remove button per project, plus the switch', () => {
		const markup = page('projects')
		expect(markup).toContain('App')
		expect(markup).toContain('/work/docs')
		expect(markup).toContain('Trusted')
		expect(markup).toContain('Not trusted yet')
		expect(markup).toContain('aria-label="Remove App…"')
		expect(markup).toContain('aria-label="Remove Docs…"')
		expect(markup).toMatch(/<input[^>]*role="switch"[^>]*>/)
		expect((markup.match(/<input[^>]*role="switch"[^>]*>/) ?? [''])[0]).toContain('checked=""')
		expect(markup).toContain('Ask again when a project’s automatic settings change')
		expect(page('projects', { onRemoveProject: undefined })).not.toContain('Remove App')
		expect(page('projects', { projects: [] })).toContain('No projects yet')
	})

	it('Appearance has the three themes with the current one selected', () => {
		const markup = page('appearance', { appearance: 'light' })
		for (const label of ['Light', 'Dark', 'System']) expect(markup).toContain(label)
		expect(isChecked(markup, 'light')).toBe(true)
		expect(isChecked(markup, 'dark')).toBe(false)
	})

	it('Updates shows the version, the last check, the status and the automatic switch', () => {
		const markup = page('updates')
		expect(markup).toContain('0.1.0')
		expect(markup).toContain('Last checked: 5 minutes ago')
		expect(markup).toContain('Namzu is up to date.')
		expect(markup).toContain('Check for updates')
		expect(markup).toContain('Download updates automatically')
		const off = page('updates', {
			settings: {
				settings: { ...DEFAULT_DESKTOP_SETTINGS, autoDownloadUpdates: false },
				error: '',
				change: async () => {},
				confirmation: undefined,
				confirm: async () => {},
				dismiss: () => {},
			},
		})
		expect((off.match(/<input[^>]*role="switch"[^>]*>/) ?? [''])[0]).not.toContain('checked=""')
		expect(off).toMatch(/<input[^>]*role="switch"/)
	})

	it('Updates offers Download for an offered update and disables Check while busy', () => {
		const offered = page('updates', {
			update: {
				state: { status: 'available', version: '2.0.0' },
				info: { currentVersion: '0.1.0' },
				onOpen: () => {},
				onCheck: () => {},
				onDownload: () => {},
			},
		})
		expect(offered).toContain('Version 2.0.0 is available.')
		expect(offered).toContain('Download update')
		expect(offered).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Check for updates/s)
		expect(offered).toContain('Last checked: Not checked yet')
		expect(page('updates', { update: undefined })).toContain('managed outside')
	})

	it('Speech shows status, size and location, with Remove for an installed voice', () => {
		const markup = page('speech')
		expect(markup).toContain('Voice')
		expect(markup).toContain('On this device')
		expect(markup).toContain('Total installed size')
		expect(markup).toContain('Stored in')
		expect(markup).toContain('local-speech')
		expect(markup).toContain('Remove voice…')
		const missing = page('speech', { speech: speech('missing') })
		expect(missing).toContain('Download voice')
		expect(missing).not.toContain('Remove voice…')
	})

	it('About shows the versions, the folders with Open buttons, and the licenses', () => {
		const markup = page('about')
		for (const text of ['0.1.0', '25.3.0', '25.2.1', 'win32 x64', 'Desktop app data'])
			expect(markup).toContain(text)
		expect(markup).toContain('aria-label="Open Desktop app data"')
		expect(markup).toContain('Open-source licenses')
		expect(markup).toContain('Third-party notices text')
		expect(page('about', { info: { ...info, cliVersion: undefined } })).toContain('Not found')
		expect(page('about', { info: undefined })).toContain('Loading')
		expect(page('about', { onOpenFolder: undefined })).not.toContain('aria-label="Open Desktop')
	})

	it('shows a failed save as an alert', () => {
		const markup = page('general', {
			settings: {
				settings: undefined,
				error: 'Namzu could not save this setting.',
				change: async () => {},
				confirmation: undefined,
				confirm: async () => {},
				dismiss: () => {},
			},
		})
		expect(markup).toContain('role="alert"')
		expect(markup).toContain('could not save')
		expect(markup).toMatch(/<fieldset[^>]*disabled/)
	})
})

describe('the settings sidebar', () => {
	it('lists every section as a button and marks the current one', () => {
		const markup = renderToStaticMarkup(
			createElement(SettingsSidebar, { section: 'updates', onSection: () => {} }),
		)
		expect(markup).toContain('aria-label="Settings sections"')
		for (const title of ['General', 'Projects', 'Appearance', 'Updates', 'Speech', 'About'])
			expect(markup).toContain(`<span>${title}</span>`)
		expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
		expect(markup).toMatch(/aria-current="page"[^>]*>(?:(?!<\/button>).)*Updates/s)
	})
})
