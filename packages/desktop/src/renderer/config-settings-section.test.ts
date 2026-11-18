import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
	type ConfigSettingsView,
	readConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import {
	type CONFIG_GROUP_SECTIONS,
	OWN_ROW_CONFIG_PATHS,
	configRowRuns,
	configSearchEntries,
	configSettingId,
	confirmationCopy,
	defaultToggle,
	numberFromText,
} from './config-settings-model.js'
import { ConfigSettingsGroup } from './config-settings-section.js'
import { searchSettings } from './settings-model.js'
import type { ConfigSettingsControls } from './use-config-settings.js'

const view: ConfigSettingsView = {
	file: '/x/config.yaml',
	descriptors: [
		{
			path: 'limits.doneGate',
			label: 'Check before finishing',
			description: 'Check once.',
			section: 'agent',
			control: { kind: 'toggle' },
			defaultText: 'on',
		},
		{
			path: 'limits.maxIterations',
			label: 'Most steps per task',
			description: '0 means no limit.',
			section: 'agent',
			control: { kind: 'number', min: 0 },
			defaultText: 'no limit',
		},
		{
			path: 'format',
			label: 'Output format',
			description: 'How results print.',
			section: 'agent',
			control: {
				kind: 'select',
				options: [
					{ value: 'text', label: 'text' },
					{ value: 'json', label: 'json' },
				],
			},
		},
		{
			path: 'permissions',
			label: 'Permission rules',
			description: 'Allow or deny.',
			section: 'agent',
			control: { kind: 'json', example: '{}' },
		},
		{
			path: 'mcpServers',
			label: 'Connected servers',
			description: 'Edit in the file.',
			section: 'agent',
			control: { kind: 'file-only' },
		},
		{
			path: 'tui.mouse',
			label: 'Mouse',
			description: 'full or off',
			section: 'terminal',
			control: { kind: 'select', options: [{ value: 'full', label: 'full' }] },
		},
	],
	settings: [
		{ path: 'limits.maxIterations', set: true, value: 7 },
		{ path: 'mcpServers', set: true },
	],
}

const controls = (over: Partial<ConfigSettingsControls> = {}): ConfigSettingsControls => ({
	view,
	loadError: '',
	loading: false,
	reload: () => {},
	resets: {},
	discard: () => {},
	errors: {},
	change: vi.fn(async () => true),
	confirmation: undefined,
	confirm: vi.fn(),
	dismiss: vi.fn(),
	...over,
})
const html = (section: 'agent' | 'terminal', config = controls()) =>
	renderToStaticMarkup(createElement(ConfigSettingsGroup, { section, config }))

describe('engine settings in the page', () => {
	it('draws each control the engine describes, with a one-line description', () => {
		const out = html('agent')
		expect(out).toContain('role="switch"')
		expect(out).toContain('type="number"')
		expect(out).toContain('value="7"')
		expect(out).toContain('<select')
		expect(out).toContain('<textarea')
		expect(out).toContain('Check once.')
		expect(out).toContain('Default: on.')
		expect(out).not.toContain('Mouse')
	})

	it('shows a file-only setting as set or not, never its value', () => {
		const out = html('agent')
		expect(out).toContain('Set in your config file')
		expect(out).not.toContain('<textarea aria-label="Connected servers"')
	})

	it('offers to go back to the default only for a saved value', () => {
		const out = html('agent')
		expect(out.match(/Use the default for/g)?.length).toBe(1)
		expect(out).toContain('Use the default for Most steps per task')
	})

	it('shows the engine error under the field that caused it', () => {
		const out = html(
			'agent',
			controls({ errors: { 'limits.maxIterations': 'must be a whole number' } }),
		)
		expect(out).toContain('role="alert"')
		expect(out).toContain('must be a whole number')
	})

	it('words the confirmation from the engine sentence', () => {
		expect(confirmationCopy('Mouse changes.')).toEqual({
			title: 'Change this setting?',
			description: 'Mouse changes.',
			confirm: 'Change it',
			cancel: 'Cancel',
		})
	})

	it('draws nothing before the engine answers', () => {
		expect(html('agent', controls({ view: undefined }))).toBe('')
	})

	it('is found by search', () => {
		const found = searchSettings('steps', configSearchEntries(view))
		expect(found.map((e) => e.id)).toEqual([configSettingId('limits.maxIterations')])
	})
})

describe('helpers', () => {
	it('reads the default of a switch from its words', () => {
		expect(defaultToggle(view.descriptors[0]!)).toBe(true)
		expect(defaultToggle(view.descriptors[1]!)).toBe(false)
	})
	it('checks a number before it is sent', () => {
		expect(numberFromText('', {})).toEqual({ error: 'Enter a number.' })
		expect(numberFromText('x', {})).toEqual({ error: 'Enter a number.' })
		expect(numberFromText('1', { min: 2 })).toEqual({ error: 'Enter 2 or more.' })
		expect(numberFromText('17', { max: 16 })).toEqual({ error: 'Enter 16 or less.' })
		expect(numberFromText(' 8 ', { min: 2, max: 16 })).toEqual({ value: 8 })
	})
})

describe('what every page with engine rows says when the list is not there', () => {
	const failed = controls({ view: undefined, loadError: 'Could not read your settings.' })
	it('shows the plain message and a Try again button on every page, not a blank one', () => {
		for (const section of [
			'general',
			'models',
			'agent',
			'tools',
			'projects',
			'terminal',
		] as const) {
			const markup = renderToStaticMarkup(
				createElement(ConfigSettingsGroup, { section, config: failed }),
			)
			expect(markup, section).toContain('Could not read your settings.')
			expect(markup, section).toContain('Try again')
		}
	})
	it('says it is reading while the first read is out, and nothing when there is no engine', () => {
		const reading = renderToStaticMarkup(
			createElement(ConfigSettingsGroup, {
				section: 'tools',
				config: controls({ view: undefined, loading: true }),
			}),
		)
		expect(reading).toContain('Reading your settings')
		expect(
			renderToStaticMarkup(
				createElement(ConfigSettingsGroup, {
					section: 'tools',
					config: controls({ view: undefined }),
				}),
			),
		).toBe('')
	})
})

describe('search offers only rows the page draws', () => {
	const wide: ConfigSettingsView = {
		file: '/x/config.yaml',
		descriptors: [
			...view.descriptors,
			{
				path: 'mcpServers',
				label: 'Connected servers',
				description: 'Servers.',
				section: 'tools',
				control: { kind: 'file-only' },
			},
			{
				path: 'disableHooks',
				label: 'Turn off hooks',
				description: 'Do not run hooks.',
				section: 'tools',
				control: { kind: 'toggle' },
			},
			{
				path: 'hooks',
				label: 'Hooks',
				description: 'Edit them in the config file.',
				section: 'tools',
				control: { kind: 'file-only' },
			},
		],
		settings: [],
	}
	it('leaves out the rows Desktop draws as its own, and points the words at them', () => {
		const ids = configSearchEntries(wide).map((entry) => entry.id)
		expect(ids).not.toContain('cfg-mcpServers')
		expect(ids).not.toContain('cfg-disableHooks')
		expect(ids).not.toContain('cfg-hooks')
		const found = (query: string) => searchSettings(query).map((entry) => entry.id)
		expect(found('connected servers')).toContain('mcpServers')
		expect(found('turn off hooks')).toContain('runHooks')
		expect(found('hooks').filter((id) => id === 'hooks')).toHaveLength(1)
	})
	it('finds the graphics card and the engine switch', () => {
		expect(searchSettings('graphics').map((entry) => entry.id)).toContain('hardware-acceleration')
		expect(searchSettings('keep engine').map((entry) => entry.id)).toContain('keep-engine')
	})
})

describe('headings inside a section', () => {
	const row = (path: string, group?: string, groupLabel?: string) => ({
		path,
		label: path,
		description: path,
		section: 'terminal' as const,
		control: { kind: 'toggle' as const },
		...(group ? { group, groupLabel } : {}),
	})
	const grouped: ConfigSettingsView = {
		file: '/x/config.yaml',
		descriptors: [
			row('tui.mouse', 'terminal-app', 'Terminal app'),
			row('tui.sound', 'terminal-app', 'Terminal app'),
			row('format', 'command-line', 'Command line'),
			row('quiet', 'command-line', 'Command line'),
		],
		settings: [],
	}
	const markup = (view: ConfigSettingsView | undefined = grouped) =>
		renderToStaticMarkup(
			createElement(ConfigSettingsGroup, { section: 'terminal', config: controls({ view }) }),
		)

	it('draws one heading over each group, in the order the engine lists them, rows beneath', () => {
		const out = markup()
		const headings = [...out.matchAll(/<h2 class="settings-section-title">([^<]+)<\/h2>/g)].map(
			(match) => match[1],
		)
		expect(headings).toEqual(['Terminal app', 'Command line'])
		expect(out.indexOf('Terminal app')).toBeLessThan(out.indexOf('id="setting-cfg-tui-mouse"'))
		expect(out.indexOf('id="setting-cfg-tui-sound"')).toBeLessThan(out.indexOf('Command line'))
		expect(out.indexOf('Command line')).toBeLessThan(out.indexOf('id="setting-cfg-format"'))
	})

	it('draws a row with no group above the groups and an older engine with no headings at all', () => {
		const runs = configRowRuns([
			row('tui.mouse', 'terminal-app', 'Terminal app'),
			row('limits.x'),
		] as never)
		expect(runs.map((run) => run.heading)).toEqual([undefined, 'Terminal app'])
		const old = markup({
			...grouped,
			descriptors: grouped.descriptors.map(({ group, groupLabel, ...rest }) => rest),
		})
		expect(old).not.toContain('settings-section-title')
		expect(old).toContain('id="setting-cfg-format"')
	})

	it('reads a group only when the engine sent its words with it', () => {
		const read = readConfigSettingsView({
			file: '/x',
			settings: [],
			descriptors: [
				{ ...row('a', 'command-line', 'Command line') },
				{ ...row('b'), group: 'command-line' },
			],
		})
		expect(read.descriptors[0]).toMatchObject({ group: 'command-line', groupLabel: 'Command line' })
		expect(read.descriptors[1]).not.toHaveProperty('group')
	})
})

/** The engine's own list, read as Desktop reads it from the wire. */
const CLI_DESCRIPTORS = fileURLToPath(
	new URL('../../../cli/src/config/settings-descriptors.ts', import.meta.url),
)
const CLI_SETTINGS = fileURLToPath(
	new URL('../../../cli/src/config/desktop-settings.ts', import.meta.url),
)

// The first import loads the engine's config loader through its source, which is slow on a loaded runner.
const SLOW_IMPORT_MS = 30_000

describe('the real engine list, section by section', () => {
	const real = async (): Promise<ConfigSettingsView> => {
		const { SETTING_DESCRIPTORS } = (await import(/* @vite-ignore */ CLI_DESCRIPTORS)) as {
			SETTING_DESCRIPTORS: readonly { path: string }[]
		}
		const { withDefaultText } = (await import(/* @vite-ignore */ CLI_SETTINGS)) as {
			withDefaultText: (entry: unknown) => unknown
		}
		return readConfigSettingsView(
			JSON.parse(
				JSON.stringify({
					file: '/x/config.yaml',
					settings: [],
					descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
				}),
			),
		)
	}
	const draw = (view: ConfigSettingsView, section: (typeof CONFIG_GROUP_SECTIONS)[number]) =>
		renderToStaticMarkup(
			createElement(ConfigSettingsGroup, {
				section,
				config: controls({ view }),
				omit: section === 'tools' ? OWN_ROW_CONFIG_PATHS : undefined,
			}),
		)

	it(
		'lands every search hit on a drawn row in the section the hit names',
		async () => {
			const view = await real()
			const pages = new Map<string, string>()
			const hits = configSearchEntries(view)
			expect(hits.length).toBeGreaterThan(50)
			for (const hit of hits) {
				if (!pages.has(hit.section)) pages.set(hit.section, draw(view, hit.section))
				expect(pages.get(hit.section), `${hit.id} in ${hit.section}`).toContain(
					`id="setting-${hit.id}"`,
				)
			}
		},
		SLOW_IMPORT_MS,
	)

	it(
		'finds the update rows by the words a person types for them',
		async () => {
			const view = await real()
			const entries = configSearchEntries(view)
			for (const words of ['automatic update', 'auto update', 'automatic updates']) {
				const hits = searchSettings(words, entries).filter((e) => e.section === 'updates')
				expect(
					hits.map((e) => e.id),
					words,
				).toContain(configSettingId('updates.auto'))
			}
		},
		SLOW_IMPORT_MS,
	)

	it(
		'puts each moved row in its new section and heading',
		async () => {
			const view = await real()
			const where = new Map(view.descriptors.map((d) => [d.path, d]))
			const check = (path: string, section: string, group?: string) => {
				expect(where.get(path)?.section, path).toBe(section)
				expect(where.get(path)?.group, path).toBe(group)
			}
			check('updates.auto', 'updates', 'command-line')
			check('updates.check', 'updates', 'command-line')
			check('updates.channel', 'updates', 'command-line')
			check('browser.enabled', 'tools')
			check('codeAnalysis.enabled', 'tools')
			check('format', 'terminal', 'command-line')
			check('quiet', 'terminal', 'command-line')
			check('tui.theme', 'terminal', 'terminal-app')
			check('composerTriggers.enabled', 'terminal', 'terminal-app')
			check('statusLine', 'terminal', 'terminal-app')
			check('hypermode', 'agent')
			// The browser switch leads the browser rows.
			const tools = draw(view, 'tools')
			expect(tools.indexOf('id="setting-cfg-browser-enabled"')).toBeLessThan(
				tools.indexOf('id="setting-cfg-browser-defaultProfile"'),
			)
		},
		SLOW_IMPORT_MS,
	)

	it(
		'orders the Terminal and Updates headings',
		async () => {
			const view = await real()
			const headings = (section: (typeof CONFIG_GROUP_SECTIONS)[number]) =>
				[...draw(view, section).matchAll(/<h2 class="settings-section-title">([^<]+)<\/h2>/g)].map(
					(match) => match[1],
				)
			expect(headings('terminal')).toEqual(['Terminal app', 'Command line'])
			expect(headings('updates')).toEqual(['Command line'])
			// Updates draws the engine's three rows only, so the general “Namzu settings” has no place.
			expect(draw(view, 'updates')).not.toContain('Namzu settings')
		},
		SLOW_IMPORT_MS,
	)
})
