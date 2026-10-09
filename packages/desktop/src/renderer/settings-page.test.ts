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
import { SETTINGS_SECTION_TITLES } from './settings-model.js'
import {
	SettingsPage,
	type SettingsPageProps,
	SettingsSidebar,
	TerminalSettings,
} from './settings-page.js'
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
	it('is a labelled region whose one h1 is the section, never a second "Settings" heading', () => {
		for (const section of SETTINGS_SECTIONS) {
			const markup = page(section)
			expect(markup).toContain('aria-label="Settings"')
			expect(markup.match(/<h1>/g)).toHaveLength(1)
			expect(markup).toContain(`<h1>${SETTINGS_SECTION_TITLES[section]}</h1>`)
			expect(markup).not.toContain('<h1>Settings</h1>')
			expect(markup).toContain('aria-label="Search settings"')
			expect(markup).not.toContain('<h2 class="settings-section-title">')
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
		expect(markup).toContain('Up to date.')
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

	it('every section opens with the same header: a title and one subtitle line', () => {
		for (const section of SETTINGS_SECTIONS) {
			const header = page(section).match(/<header class="settings-page-header">(.*?)<\/header>/s)
			expect(header?.[1], section).toMatch(/<h1>[^<]+<\/h1><p>[^<]+<\/p>/)
		}
	})

	it('names one re-check button and does not claim a check this copy cannot make', () => {
		const disabled = page('updates', {
			update: {
				state: { status: 'disabled' },
				info: { currentVersion: '0.1.0' },
				onOpen: () => {},
				onCheck: () => {},
			},
		})
		expect(disabled).not.toContain('Last checked')
		expect(disabled).not.toContain('Check the programs')
		expect(page('updates')).toContain('Last checked: 5 minutes ago')
	})

	it('Updates hides the automatic-download switch where the app cannot update itself', () => {
		const disabled = page('updates', {
			update: {
				state: { status: 'disabled' },
				info: { currentVersion: '0.1.0' },
				onOpen: () => {},
				onCheck: () => {},
			},
		})
		expect(disabled).not.toContain('Download updates automatically')
		expect(disabled).toContain('Namzu Desktop version')
		expect(page('updates', { update: undefined })).not.toContain('Download updates automatically')
	})

	it('Default terminal shell is a row only where there is a shell to choose', () => {
		const settings = {
			settings: { ...DEFAULT_DESKTOP_SETTINGS },
			error: '',
			change: async () => {},
			confirmation: undefined,
			confirm: async () => {},
			dismiss: () => {},
		}
		const render = (shells: { value: string; label: string }[] | null | undefined) =>
			renderToStaticMarkup(createElement(TerminalSettings, { settings, shells }))
		expect(render([{ value: 'auto', label: 'Login shell' }])).not.toContain(
			'Default terminal shell',
		)
		expect(render(undefined)).not.toContain('Default terminal shell')
		expect(render(null)).toBe('')
		const windows = render([
			{ value: 'auto', label: 'Automatic' },
			{ value: 'cmd', label: 'Command Prompt' },
		])
		expect(windows).toContain('Default terminal shell')
		expect(windows).toContain('Command Prompt')
		expect(windows).toContain('Bring terminal tabs back')
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
		expect(offered).toContain('Update available: version 2.0.0.')
		expect(offered).toContain('Download update')
		expect(offered).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>).)*Check for updates/s)
		expect(offered).toContain('Last checked: Not checked yet')
		expect(page('updates', { update: undefined })).toContain('managed outside')
	})

	it('Speech shows size, no raw path, with Remove for an installed voice', () => {
		const markup = page('speech')
		expect(markup).toContain('Voice')
		expect(markup).toContain('On this device')
		expect(markup).toContain('Space used')
		expect(markup).not.toContain('Roaming')
		expect(markup).not.toContain('AppData')
		expect(markup).toContain('Remove voice…')
		const missing = page('speech', { speech: speech('missing') })
		expect(missing).toContain('Download voice')
		expect(missing).not.toContain('Remove voice…')
	})

	it('About shows the versions, and the folders with Open buttons', () => {
		const markup = page('about')
		for (const text of [
			'0.1.0',
			'<dt>Namzu command line (bundled with this app)</dt><dd>25.3.0</dd>',
			'25.2.1',
			'Windows (64-bit Intel or AMD)',
			'Desktop app data',
			'aria-label="Copy version details"',
		])
			expect(markup).toContain(text)
		expect(markup).not.toContain('win32 x64')
		// Raw paths appear only under Data folders.
		expect(markup.slice(0, markup.indexOf('Data folders'))).not.toContain('AppData')
		expect(markup).toContain('aria-label="Open Desktop app data"')
		expect(page('about', { info: { ...info, cliVersion: undefined } })).toContain('Not found')
		expect(markup).not.toContain('installed separately')
		const both = page('about', { info: { ...info, installedCliVersion: '35.0.0' } })
		expect(both).toContain('<dt>Namzu command line (installed separately)</dt><dd>35.0.0</dd>')
		// Folders say what is safe to delete and what holds the person's work.
		expect(both).toContain('Safe to delete; it downloads again when needed.')
		expect(both).toContain('Deleting it resets the app.')
		expect(both).toContain('The Namzu home folder holds your work')
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
