import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EngineDeliveryView } from '../shared/engine-delivery-protocol.js'
import type { KernelNewer } from '../shared/engine-update-protocol.js'
import type { LocalListeningState } from '../shared/local-listening-protocol.js'
import type { LocalSpeechState } from '../shared/local-speech-protocol.js'
import type { ProjectView } from '../shared/protocol.js'
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopInfo,
	SETTINGS_SECTIONS,
	type SettingsSection,
} from '../shared/settings-protocol.js'
import { SETTINGS_SECTION_TITLES, aboutDetailsText } from './settings-model.js'
import {
	SettingsPage,
	type SettingsPageProps,
	SettingsSidebar,
	TerminalSettings,
} from './settings-page.js'
import { EngineDeliveryContext } from './use-engine-delivery.js'
import { EngineUpdatesContext } from './use-engine-updates.js'
import type { LocalListeningControls } from './use-local-listening.js'
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
const listeningControls = (
	installation: LocalListeningState['installation'] = 'ready',
): LocalListeningControls => ({
	state: {
		installation,
		engine: 'unloaded',
		device: 'cpu',
		downloadBytes: 1_037_257_645,
		diskBytes: installation === 'ready' ? 1_037_257_645 : null,
	},
	supported: true,
	loading: false,
	busy: false,
	install: vi.fn(),
	cancelInstall: vi.fn(),
	uninstall: vi.fn(),
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

function page(
	section: SettingsSection,
	over: Partial<SettingsPageProps> = {},
	kernel?: KernelNewer,
	delivery?: EngineDeliveryView,
) {
	const element = createElement(SettingsPage, {
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
		listening: listeningControls(),
		info,
		onOpenFolder: () => {},
		now: 1_000 + 5 * 60_000,
		...over,
	})
	const withKernel = kernel
		? createElement(
				EngineUpdatesContext.Provider,
				{
					value: {
						state: { items: [], checking: false, kernel },
						check: () => {},
						update: async () => ({ ok: false as const, reason: '' }),
						openUpdates: () => {},
						registerOpenUpdates: () => () => {},
					},
				},
				element,
			)
		: element
	return renderToStaticMarkup(
		delivery
			? createElement(
					EngineDeliveryContext.Provider,
					{ value: { view: delivery, chooseOwn: async () => {} } },
					withKernel,
				)
			: withKernel,
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

	it('Speech also holds the Voice input card beside the read-aloud voice', () => {
		const ready = page('speech')
		expect(ready).toContain('id="setting-voice"')
		expect(ready).toContain('id="setting-voice-input"')
		expect(ready).toContain('Voice input')
		expect(ready).toContain('Remove voice input…')
		const missing = page('speech', { listening: listeningControls('missing') })
		expect(missing).toContain('Download voice input')
		expect(missing).toContain('about 1 GB')
		expect(missing).not.toContain('Remove voice input…')
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

describe('settings words and paths', () => {
	it('shows a project whose folder is gone plainly, with Locate and Remove', () => {
		const markup = page('projects', {
			projects: [project({ missing: true, status: 'error', path: '/home/me/gone' })],
			onLocateProject: () => {},
		})
		expect(markup).toContain('Folder not found')
		expect(markup).not.toContain('Needs reconnecting')
		expect(markup).toContain('Locate folder')
		expect(markup).toContain('Remove')
		expect(markup).toContain('~/gone')
		expect(markup).toContain('title="/home/me/gone"')
	})

	it('offers no Locate for a folder that is there', () => {
		expect(page('projects', { onLocateProject: () => {} })).not.toContain('Locate folder')
	})

	it('writes data folders with ~, the whole path on hover and a Copy path action', () => {
		const markup = page('about')
		expect(markup).toContain('~/AppData/Roaming/Namzu')
		expect(markup).toContain('title="C:/Users/me/AppData/Roaming/Namzu"')
		expect(markup).toContain('Copy path')
		expect(markup).toContain('Safe to delete')
	})

	describe('About, when the registry knows a newer kernel than the one bundled', () => {
		it('is quiet without a kernel fact', () => {
			expect(page('about')).not.toContain('A newer one exists')
		})
		it('says it once under each version', () => {
			const markup = page('about', {}, { cli: '51.0.1', engine: '62.12.0' })
			expect(markup).toContain(
				'<dd>25.3.0</dd><dd class="settings-fact-note">A newer one exists (51.0.1). It arrives with an update of this app.</dd>',
			)
			expect(markup).toContain(
				'<dd>25.2.1</dd><dd class="settings-fact-note">A newer one exists (62.12.0). It arrives with an update of this app.</dd>',
			)
		})
		it('says it only where there is one', () => {
			const markup = page('about', {}, { engine: '62.12.0' })
			expect(markup.match(/A newer one exists/g)).toHaveLength(1)
			expect(markup).not.toContain('(51.0.1)')
		})
	})

	it('names the engine without developer words in About', () => {
		const markup = page('about')
		expect(markup).toContain('Namzu engine')
		expect(markup).not.toContain('SDK')
	})
})

describe('the engine the app keeps current', () => {
	const view = (over: Partial<EngineDeliveryView> = {}): EngineDeliveryView => ({
		available: true,
		enabled: true,
		runs: { source: 'bundled', commandLine: '25.3.0', engine: '25.2.1' },
		bundled: { commandLine: '25.3.0', engine: '25.2.1' },
		status: { kind: 'current', checkedAt: 1_000 },
		canUseOwn: false,
		...over,
	})
	// A day in 2026, so a date in November has no year beside it.
	const NOW = Date.UTC(2026, 10, 12, 12)
	const fetched = view({
		runs: {
			source: 'managed',
			commandLine: '26.0.0',
			engine: '25.9.0',
			since: Date.UTC(2026, 10, 12, 8),
		},
		canUseOwn: true,
	})

	it('changes nothing on either screen where this build has no signing key', () => {
		// No controls reach the page: the markup is what it was before engines could be fetched.
		for (const section of ['updates', 'about'] as const) {
			const plain = page(section)
			expect(plain).not.toContain('Keep the engine up to date')
			expect(plain).not.toContain('Updated by itself')
			expect(plain).not.toContain('Use this app’s own engine')
			expect(plain).not.toContain('developer override')
		}
		expect(page('about')).toContain(
			'<dt>Namzu command line (bundled with this app)</dt><dd>25.3.0</dd>',
		)
	})

	it('Updates has the engine row, the switch and nothing to press when this app’s own engine runs', () => {
		const markup = page('updates', { now: 1_000 + 5 * 60_000 }, undefined, view())
		expect(markup).toContain('Namzu engine')
		expect(markup).toContain('Running 25.3.0. This app’s own engine.')
		expect(markup).toContain('The engine is up to date. Last checked: 5 minutes ago.')
		expect(markup).toContain('Keep the engine up to date')
		expect(markup).toContain('aria-label="Keep the engine up to date"')
		expect(markup).not.toContain('Use this app’s own engine')
	})

	it('Updates draws every state of the row', () => {
		const say = (status: EngineDeliveryView['status'], over: Partial<EngineDeliveryView> = {}) =>
			page('updates', {}, undefined, view({ status, ...over }))
		expect(say({ kind: 'ready', version: '26.0.0' }, { canUseOwn: true })).toContain(
			'A newer engine (26.0.0) is ready. It takes effect the next time a project opens.',
		)
		expect(
			say({ kind: 'went-back', version: '26.0.0', problem: 'did-not-start', to: '25.3.0' }),
		).toContain('Could not use engine 26.0.0 (it did not start) and went back to 25.3.0.')
		expect(say({ kind: 'needs-newer-app' })).toContain(
			'A newer engine is out, but it needs a newer version of this app.',
		)
		expect(say({ kind: 'cannot-check', since: Date.UTC(2026, 10, 3) })).toContain(
			'Could not check for a newer engine since',
		)
		expect(say({ kind: 'off' }, { enabled: false })).toContain(
			'Off. This app runs the engine it was installed with.',
		)
		expect(
			say({ kind: 'override' }, { runs: { source: 'override', commandLine: '99.0.0' } }),
		).toContain('A developer override is in use, so the engine is not updated.')
		expect(say({ kind: 'unknown' })).toContain('Not checked yet.')
		expect(say({ kind: 'checking' })).toContain('Checking for a newer engine…')
	})

	it('shows the switch off when the setting is off, and offers the way back when a fetched engine exists', () => {
		const off = page(
			'updates',
			{
				now: NOW,
				settings: {
					settings: { ...DEFAULT_DESKTOP_SETTINGS, keepEngineUpToDate: false },
					error: '',
					change: async () => {},
					confirmation: undefined,
					confirm: async () => {},
					dismiss: () => {},
				},
			},
			undefined,
			fetched,
		)
		expect(off).toMatch(/aria-label="Keep the engine up to date"[^>]*/)
		expect(off).not.toMatch(/aria-label="Keep the engine up to date"[^>]*aria-checked="true"/)
		expect(off).toContain('Use this app’s own engine')
		expect(off).toMatch(/Running 26\.0\.0\. Updated by itself on (12 Nov|Nov 12)\./u)
	})

	it('Updates draws nothing from the feed except version numbers and fixed words', () => {
		const markup = page(
			'updates',
			{},
			undefined,
			view({ status: { kind: 'ready', version: '<script>alert(1)</script>' } }),
		)
		expect(markup).not.toContain('<script>alert')
	})

	it('About says which engine runs and where it came from', () => {
		const own = page('about', {}, undefined, view())
		expect(own).toContain('<dt>Namzu command line (bundled with this app)</dt><dd>25.3.0</dd>')
		expect(own).toContain('This app’s own engine.')
		const managed = page('about', { now: NOW }, undefined, fetched)
		expect(managed).toContain('<dt>Namzu command line</dt><dd>26.0.0</dd>')
		expect(managed).toContain('<dt>Namzu engine</dt><dd>25.9.0</dd>')
		expect(managed).toMatch(/Updated by itself on (12 Nov|Nov 12)\./u)
		// The bundled version is shown as the fallback.
		expect(managed).toContain('<dt>Namzu command line (bundled with this app)</dt><dd>25.3.0</dd>')
		expect(managed).toContain('Used if the newer engine cannot start.')
		const override = page(
			'about',
			{},
			undefined,
			view({ runs: { source: 'override', commandLine: '99.0.0', engine: '98.0.0' } }),
		)
		expect(override).toContain('Developer override.')
		expect(override).toContain('<dt>Namzu command line</dt><dd>99.0.0</dd>')
	})

	it('Copy details is a button that carries the same facts', () => {
		const text = aboutDetailsText(info, {}, { view: fetched, now: NOW, locale: 'en-GB' })
		expect(text).toContain('Namzu command line 26.0.0')
		expect(text).toContain('Namzu engine 25.9.0')
		expect(text).toContain('Engine source: Updated by itself on 12 Nov.')
		expect(text).toContain('this app’s own, used if the newer one cannot start) 25.3.0')
		expect(text).not.toMatch(/kernel|managed|manifest|bundle\b/iu)
		// Where no engine is fetched, the text is what it was.
		expect(aboutDetailsText(info, {})).not.toContain('Engine source')
	})
})
