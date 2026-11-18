import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
	type ConfigSettingsView,
	readConfigSettingsView,
} from '../shared/config-settings-protocol.js'
import { modelOptionRows } from './config-settings-lists.js'
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
import { type ConfigSettingsControls, readModelChoices } from './use-config-settings.js'

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
		// A switch shows no default line; the page does not repeat it under every row.
		expect(out).not.toContain('Default: on.')
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
			check('browser.enabled', 'tools', 'browser')
			check('codeAnalysis.enabled', 'tools', 'code-plugins')
			check('format', 'terminal', 'command-line')
			check('quiet', 'terminal', 'command-line')
			check('tui.theme', 'terminal', 'terminal-look')
			check('composerTriggers.enabled', 'terminal', 'terminal-message-box')
			check('statusLine', 'terminal', 'terminal-message-box')
			check('hypermode', 'agent', 'while-working')
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
			expect(headings('terminal')).toEqual([
				'Terminal app: look',
				'Terminal app: mouse and scrolling',
				'Terminal app: notifications',
				'Terminal app: message box',
				'Command line',
			])
			expect(headings('updates')).toEqual(['Command line'])
			// Updates draws the engine's three rows only, so the general “Namzu settings” has no place.
			expect(draw(view, 'updates')).not.toContain('Namzu settings')
		},
		SLOW_IMPORT_MS,
	)
})

describe('the typed list and map rows, drawn from the real engine list', () => {
	const drawReal = async (section: 'terminal' | 'agent' | 'telemetry') => {
		const { SETTING_DESCRIPTORS } = (await import(/* @vite-ignore */ CLI_DESCRIPTORS)) as {
			SETTING_DESCRIPTORS: readonly { path: string }[]
		}
		const { withDefaultText } = (await import(/* @vite-ignore */ CLI_SETTINGS)) as {
			withDefaultText: (entry: unknown) => unknown
		}
		const view = readConfigSettingsView(
			JSON.parse(
				JSON.stringify({
					file: '/x/config.yaml',
					settings: [],
					descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
				}),
			),
		)
		return renderToStaticMarkup(
			createElement(ConfigSettingsGroup, { section, config: controls({ view }) }),
		)
	}
	const row = (page: string, path: string) => {
		const start = page.indexOf(`id="setting-${configSettingId(path)}"`)
		expect(start, path).toBeGreaterThan(-1)
		const next = page.indexOf('<div id="setting-', start + 10)
		return page.slice(start, next === -1 ? undefined : next)
	}

	it(
		'draws three event checks and no switch of its own, and says what the idle one is',
		async () => {
			const html = row(await drawReal('terminal'), 'tui.notifications')
			// None ticked is off, so a separate switch would only repeat the checks.
			expect(html).not.toContain('role="switch"')
			expect(html.match(/type="checkbox"/g)?.length).toBe(3)
			expect(html).toContain('Waiting for you')
			expect(html).toContain('minute of quiet')
			expect(html).not.toContain('<textarea')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the workspaces key as a pick with the default named and no refused key',
		async () => {
			const html = row(await drawReal('terminal'), 'tui.workspacesPrefix')
			expect(html).toContain('<select')
			expect(html).toContain('Default · Ctrl+B')
			expect(html).toContain('value="ctrl+space"')
			for (const refused of ['ctrl+c', 'ctrl+d', 'ctrl+z', 'ctrl+i', 'ctrl+m'])
				expect(html).not.toContain(`value="${refused}"`)
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws one Arm, Suggest, Off choice per trigger with its default marked',
		async () => {
			const html = row(await drawReal('terminal'), 'composerTriggers.builtin')
			expect(html.match(/<select/g)?.length).toBe(5)
			for (const name of ['Hypermode', 'Workflow', 'Save as skill', 'Schedule', 'Maximum effort'])
				expect(html).toContain(name)
			expect(html.match(/\(default\)/g)?.length).toBe(5)
			expect(html).toContain('Suggest (default)')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the screens with the engine default ticked and a place for tools',
		async () => {
			const html = row(await drawReal('agent'), 'toolResultScreens')
			expect(html).toContain('Repeats the request')
			expect(html).toContain('Hidden instructions')
			expect(html).toContain('Tools that may repeat the request')
			expect(html.match(/checked=""/g)?.length).toBe(1)
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws every saved event type ticked while the key is absent, and the switch for secrets on',
		async () => {
			const page = await drawReal('telemetry')
			const events = row(page, 'telemetry.sessionExport.eventTypes')
			const boxes = events.match(/type="checkbox"/g)?.length ?? 0
			expect(boxes).toBeGreaterThan(40)
			expect(events.match(/checked=""/g)?.length).toBe(boxes)
			expect(events).toContain('Default · All events')
			expect(events).not.toContain('<textarea')
			const secrets = row(page, 'telemetry.sessionExport.redactors')
			expect(secrets).toContain('role="switch"')
			expect(secrets).toContain('checked=""')
		},
		SLOW_IMPORT_MS,
	)
})

describe('the extra folders and the turned-off skills, drawn from the real engine list', () => {
	const drawReal = async (
		section: 'projects' | 'agent',
		over: Partial<ConfigSettingsControls> = {},
		settings: ConfigSettingsView['settings'] = [],
	) => {
		const { SETTING_DESCRIPTORS } = (await import(/* @vite-ignore */ CLI_DESCRIPTORS)) as {
			SETTING_DESCRIPTORS: readonly { path: string }[]
		}
		const { withDefaultText } = (await import(/* @vite-ignore */ CLI_SETTINGS)) as {
			withDefaultText: (entry: unknown) => unknown
		}
		const real = readConfigSettingsView(
			JSON.parse(
				JSON.stringify({
					file: '/x/config.yaml',
					settings,
					descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
				}),
			),
		)
		return renderToStaticMarkup(
			createElement(ConfigSettingsGroup, { section, config: controls({ view: real, ...over }) }),
		)
	}
	const row = (page: string, path: string) => {
		const start = page.indexOf(`id="setting-${configSettingId(path)}"`)
		expect(start, path).toBeGreaterThan(-1)
		const next = page.indexOf('<div id="setting-', start + 10)
		return page.slice(start, next === -1 ? undefined : next)
	}
	const tools = {
		pickFolder: async () => '/x',
		existingFolders: async (paths: string[]) => paths,
		installedSkills: async () => ({ skills: [] }),
	}

	it(
		'draws the folders as lines with Remove and an Add folder button, never a JSON box',
		async () => {
			const html = row(
				await drawReal('projects', { tools }, [
					{ path: 'additionalDirectories', set: true, value: ['/data/a', '/data/b'] },
				]),
				'additionalDirectories',
			)
			expect(html).toContain('/data/a')
			expect(html).toContain('/data/b')
			expect(html.match(/>Remove</g)?.length).toBe(2)
			expect(html).toContain('Add folder')
			expect(html).not.toContain('<textarea')
			expect(html).toContain('Use default')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'says there are none by default, and types a folder only where there is no picker',
		async () => {
			const withPicker = row(await drawReal('projects', { tools }), 'additionalDirectories')
			expect(withPicker).toContain('No extra folders.')
			expect(withPicker).toContain('Default · None')
			const typed = row(await drawReal('projects', { tools: {} }), 'additionalDirectories')
			expect(typed).toContain('aria-label="Add folder"')
			expect(typed).not.toContain('>Add folder<')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the skills row from the engine’s list, and keeps the typed list where it has none',
		async () => {
			const reading = row(await drawReal('agent', { tools }), 'skills.disabled')
			expect(reading).toContain('Reading the installed skills')
			expect(reading).not.toContain('<textarea')
			const typed = row(await drawReal('agent', { tools: {} }), 'skills.disabled')
			expect(typed).toContain('aria-label="Add skill name"')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'no longer draws any of the three as a raw JSON box',
		async () => {
			const projects = await drawReal('projects', { tools })
			const agent = await drawReal('agent', { tools })
			expect(row(projects, 'additionalDirectories')).not.toContain('<textarea')
			expect(row(agent, 'skills.disabled')).not.toContain('<textarea')
			expect(projects).not.toContain('id="setting-cfg-mcpServers"')
		},
		SLOW_IMPORT_MS,
	)
})

describe('the model rows, drawn from the real engine list', () => {
	const drawModels = async (
		settings: ConfigSettingsView['settings'] = [],
		over: Partial<ConfigSettingsControls> = {},
	) => {
		const { SETTING_DESCRIPTORS } = (await import(/* @vite-ignore */ CLI_DESCRIPTORS)) as {
			SETTING_DESCRIPTORS: readonly { path: string }[]
		}
		const { withDefaultText } = (await import(/* @vite-ignore */ CLI_SETTINGS)) as {
			withDefaultText: (entry: unknown) => unknown
		}
		const real = readConfigSettingsView(
			JSON.parse(
				JSON.stringify({
					file: '/x/config.yaml',
					settings,
					descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
				}),
			),
		)
		return renderToStaticMarkup(
			createElement(ConfigSettingsGroup, {
				section: 'models',
				config: controls({ view: real, ...over }),
			}),
		)
	}
	const row = (page: string, path: string) => {
		const start = page.indexOf(`id="setting-${configSettingId(path)}"`)
		expect(start, path).toBeGreaterThan(-1)
		const next = page.indexOf('<div id="setting-', start + 10)
		return page.slice(start, next === -1 ? undefined : next)
	}

	it(
		'draws the small model as a text box that offers models, with no JSON box',
		async () => {
			const html = row(await drawModels(), 'smallModel')
			expect(html).toContain('aria-label="Model for quick tasks"')
			expect(html).toContain('list="')
			expect(html).toContain('<datalist')
			expect(html).toContain('placeholder="provider/model"')
			expect(html).not.toContain('<textarea')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'says when NAMZU_SMALL_MODEL replaces the saved model',
		async () => {
			const env = { variable: 'NAMZU_SMALL_MODEL', value: 'acme/small' }
			const page = await drawModels([{ path: 'smallModel', set: true, value: 'other', env }])
			expect(row(page, 'smallModel')).toContain(
				'NAMZU_SMALL_MODEL is set to acme/small, and Namzu uses that instead of what is saved here.',
			)
			expect(row(await drawModels(), 'smallModel')).not.toContain('NAMZU_SMALL_MODEL is set')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws routing as a form of model boxes, a choice and a time, never a JSON box',
		async () => {
			const html = row(await drawModels(), 'routing')
			for (const name of [
				'Default model',
				'Fast model',
				'Large model',
				'How a task is sized',
				'Time to decide in seconds',
			])
				expect(html).toContain(`aria-label="${name}"`)
			expect(html).toContain('Two yes or no questions')
			expect(html).toContain('One rating')
			expect(html).toContain('seconds')
			expect(html).toContain('disabled')
			expect(html).not.toContain('<textarea')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'fills the routing form from the saved table',
		async () => {
			const routing = {
				default: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
				tiers: { big: { provider: 'openai', model: 'gpt-x' } },
				strategy: 'score',
				timeoutMs: 2500,
			}
			const html = row(
				await drawModels([{ path: 'routing', set: true, value: routing }]),
				'routing',
			)
			expect(html).toContain('value="anthropic/claude-sonnet-4-5"')
			expect(html).toContain('value="openai/gpt-x"')
			expect(html).toContain('value="2.5"')
			expect(html).toContain('<option value="score" selected="">One rating</option>')
			expect(html).toContain('Use the default for Models for automatic choice')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the reviewer as a model box and four lists that show the built-in rules until changed',
		async () => {
			const html = row(await drawModels(), 'permissions.autoMode')
			expect(html).toContain('aria-label="Reviewer model"')
			expect(html).toContain('<option value="smallModel">')
			for (const name of [
				'Always allowed',
				'Blocked unless you said so',
				'Always blocked',
				'Trusted here',
			])
				expect(html).toContain(name)
			expect(html.match(/>Built-in rules</g)?.length).toBe(4)
			expect(html).not.toContain('Use the built-in rules for')
			expect(html).not.toContain('<textarea')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'shows a saved list as written and offers the built-in rules back only for that list',
		async () => {
			const saved = {
				model: 'anthropic/claude-haiku-4-5',
				allow: ['$defaults', 'Run the test suite'],
				hardDeny: [],
			}
			const html = row(
				await drawModels([{ path: 'permissions.autoMode', set: true, value: saved }]),
				'permissions.autoMode',
			)
			expect(html).toContain('value="anthropic/claude-haiku-4-5"')
			expect(html).toContain('Run the test suite')
			expect(html).toContain('Use built-in rules, Always allowed')
			expect(html).toContain('Use built-in rules, Always blocked')
			expect(html).not.toContain('Use built-in rules, Trusted here')
		},
		SLOW_IMPORT_MS,
	)
})

describe('the models a model field offers', () => {
	it('lists each model as provider/model with the provider named', () => {
		expect(
			modelOptionRows([
				{
					provider: 'anthropic',
					label: 'Anthropic',
					models: [{ id: 'claude-a', label: 'Claude A' }],
				},
				{ provider: 'openai', label: 'OpenAI', models: [{ id: 'gpt-x', label: 'GPT X' }] },
			]),
		).toEqual([
			{ value: 'anthropic/claude-a', label: 'Anthropic: Claude A' },
			{ value: 'openai/gpt-x', label: 'OpenAI: GPT X' },
		])
	})

	it('reads the providers that can answer and their lists, keeping a provider whose list fails by its default model', async () => {
		const providers = vi.fn(async () => ({
			available: [
				{ id: 'a', label: 'A', defaultModel: 'a-1' },
				{ id: 'b', label: 'B', defaultModel: 'b-1' },
				{ id: 'c', label: 'C', defaultModel: '' },
			],
			selected: null,
		}))
		const models = vi.fn(async (provider: string) => {
			if (provider === 'a') return { models: [{ id: 'a-2', label: 'A two' }], notice: null }
			throw new Error('offline')
		})
		expect(await readModelChoices(providers as never, models as never)).toEqual([
			{ provider: 'a', label: 'A', models: [{ id: 'a-2', label: 'A two' }] },
			{ provider: 'b', label: 'B', models: [{ id: 'b-1', label: 'b-1' }] },
		])
		expect(providers).toHaveBeenCalledTimes(1)
		expect(models).toHaveBeenCalledTimes(3)
	})
})

describe('the permission and browser rows, drawn from the real engine list', () => {
	const drawSection = async (
		section: 'projects' | 'tools',
		settings: ConfigSettingsView['settings'] = [],
	) => {
		const { SETTING_DESCRIPTORS } = (await import(/* @vite-ignore */ CLI_DESCRIPTORS)) as {
			SETTING_DESCRIPTORS: readonly { path: string }[]
		}
		const { withDefaultText } = (await import(/* @vite-ignore */ CLI_SETTINGS)) as {
			withDefaultText: (entry: unknown) => unknown
		}
		const real = readConfigSettingsView(
			JSON.parse(
				JSON.stringify({
					file: '/x/config.yaml',
					settings,
					descriptors: SETTING_DESCRIPTORS.map(withDefaultText),
				}),
			),
		)
		return renderToStaticMarkup(
			createElement(ConfigSettingsGroup, { section, config: controls({ view: real }) }),
		)
	}
	const row = (page: string, path: string) => {
		const start = page.indexOf(`id="setting-${configSettingId(path)}"`)
		expect(start, path).toBeGreaterThan(-1)
		const next = page.indexOf('<div id="setting-', start + 10)
		return page.slice(start, next === -1 ? undefined : next)
	}

	it(
		'draws the rules as lines with an answer each and a line to add one, never a JSON box',
		async () => {
			const rules = {
				bash: { 'git status *': 'allow', 'rm *': 'deny' },
				read: 'allow',
			}
			const html = row(
				await drawSection('projects', [{ path: 'permissions', set: true, value: rules }]),
				'permissions',
			)
			expect(html).toContain('bash &quot;git status *&quot;')
			expect(html).toContain('read (every call)')
			expect(html).toContain('aria-label="Answer for bash &quot;rm *&quot;"')
			expect(html).toContain('<option value="deny" selected="">Deny</option>')
			expect(html).toContain('aria-label="Remove read (every call)"')
			expect(html).toContain('aria-label="Add a rule: tool"')
			expect(html).toContain('aria-label="Add a rule: pattern"')
			expect(html).toContain('Use the default for Permission rules')
			expect(html).not.toContain('<textarea')
			// The mode keys have rows of their own and are not drawn as rules.
			expect(html).not.toContain('defaultMode')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws no rule lines when none are saved, with the add line only',
		async () => {
			const html = row(await drawSection('projects'), 'permissions')
			expect(html).not.toContain('aria-label="Permission rules"')
			expect(html).toContain('aria-label="Add a rule: answer"')
			expect(html).not.toContain('Use the default for')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the self-checks as tool, input and expected answer, a command for a shell tool and JSON for any other',
		async () => {
			const checks = [
				{ tool: 'bash', input: { command: 'rm -rf /' }, expect: 'deny' },
				{ tool: 'read', input: { path: 'a.txt' }, expect: 'allow' },
			]
			const html = row(
				await drawSection('projects', [{ path: 'permissionChecks', set: true, value: checks }]),
				'permissionChecks',
			)
			expect(html).toContain('bash: rm -rf /')
			expect(html).toContain('read {&quot;path&quot;:&quot;a.txt&quot;}')
			expect(html).toContain('aria-label="Add a check: tool"')
			expect(html).toContain('aria-label="Add a check: input"')
			expect(html).toContain('Input as JSON')
			expect(html).not.toContain('<textarea')
		},
		SLOW_IMPORT_MS,
	)

	it(
		'draws the sites as lines and a fixed line for every other site that shows the default',
		async () => {
			const sites = { 'https://example.com': 'read', '*': 'deny' }
			const saved = row(
				await drawSection('tools', [{ path: 'browser.sites', set: true, value: sites }]),
				'browser.sites',
			)
			expect(saved).toContain('https://example.com')
			expect(saved).toContain('aria-label="Level for every other site"')
			expect(saved).toContain('<option value="deny" selected="">Deny</option>')
			expect(saved).not.toContain('<textarea')
			const bare = row(await drawSection('tools'), 'browser.sites')
			expect(bare).toContain('Every other site')
			expect(bare).toContain('Default · Ask')
			expect(bare).toContain('aria-label="Add a site"')
		},
		SLOW_IMPORT_MS,
	)
})
