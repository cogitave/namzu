import { Tabs } from '@base-ui/react/tabs'
import { type ReactElement, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ComposerPlugin, ComposerPluginInventory } from './composer-plugins.js'
import { ConnectorsTable } from './customize-connectors.js'
import {
	NO_CONNECTORS,
	NO_PLUGINS,
	NO_SKILLS,
	type SkillRowModel,
	connectorRow,
	groupSkills,
} from './customize-model.js'
import { CustomizeHeader } from './customize-parts.js'
import { PluginDetail, PluginsEmpty, PluginsList } from './customize-plugins.js'
import { SkillContentsView, SkillDetail, SkillsEmpty, SkillsList } from './customize-skills.js'

const NOW = Date.parse('2026-11-27T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()
const html = (node: ReactElement) => renderToStaticMarkup(node)
const none = () => {}

const row = (over: Partial<SkillRowModel> = {}): SkillRowModel => ({
	name: 'notes',
	description: 'Keep notes in one place.',
	tier: 'user',
	place: 'user',
	state: 'on',
	fileCount: 3,
	removable: true,
	updatedAt: day(3),
	...over,
})

const header = (over: Partial<Parameters<typeof CustomizeHeader>[0]> = {}) =>
	html(
		createElement(
			Tabs.Root,
			{ value: over.tab ?? 'skills' },
			createElement(CustomizeHeader, {
				tab: 'skills',
				onTab: none,
				query: '',
				onQuery: none,
				sort: 'name',
				onSort: none,
				searchLabel: 'Search skills',
				add: { items: [{ label: 'Create with Namzu', onSelect: none }] },
				...over,
			}),
		),
	)

describe('the header row', () => {
	it('has three tabs, a search, a sort button and Add on Skills', () => {
		const markup = header()
		for (const label of ['Skills', 'Connectors', 'Plugins']) expect(markup).toContain(`>${label}<`)
		expect(markup).toContain('aria-label="Search skills"')
		expect(markup).toContain('aria-label="Sort"')
		expect(markup).toContain('customize-add')
	})
	it('has no Sort on Connectors and no Add on Plugins', () => {
		expect(header({ tab: 'connectors' })).not.toContain('aria-label="Sort"')
		const plugins = header({ tab: 'plugins', add: undefined })
		expect(plugins).not.toContain('customize-add')
		expect(plugins).toContain('aria-label="Sort"')
	})
	it('offers a way to clear the search once something is typed', () => {
		expect(header()).not.toContain('Clear search')
		expect(header({ query: 'no' })).toContain('Clear search')
	})
})

describe('the Skills tab', () => {
	const rows = [
		row({ name: 'mine' }),
		row({ name: 'proj', tier: 'project', place: 'project', state: 'off' }),
		row({ name: 'half', state: 'name-only' }),
		row({ name: 'solo', state: 'user-only' }),
		row({ name: 'from-plugin', tier: 'plugin', place: 'plugin', plugin: 'acme' }),
		row({
			name: 'core',
			tier: 'system',
			place: 'built-in',
			removable: false,
			updatedAt: undefined,
		}),
	]
	const list = html(
		createElement(SkillsList, {
			groups: groupSkills(rows, { query: '', sort: 'name' }),
			now: NOW,
			onOpen: none,
			onToggle: none,
		}),
	)
	it('has a group per place, in order, with a count', () => {
		const at = ['This project', 'Yours', 'From plugins', 'Built-in'].map((t) => list.indexOf(t))
		expect(at.every((n) => n >= 0)).toBe(true)
		expect([...at].sort((a, b) => a - b)).toEqual(at)
		expect(list).toContain('customize-count')
	})
	it('shows a chip for each state that is not on, and the plugin’s name', () => {
		for (const chip of ['Off', 'Name only', 'You only', 'acme'])
			expect(list).toContain(`customize-chip">${chip}<`)
		expect(list).toContain('data-off="true"')
	})
	it('says place and description, and the updated time', () => {
		expect(list).toContain('user · Keep notes in one place.')
		expect(list).toContain('3d ago')
	})
	it('has a menu on a skill of the person’s and none on a plugin’s', () => {
		expect(list).toContain('aria-label="Actions for mine"')
		expect(list).not.toContain('aria-label="Actions for from-plugin"')
	})
	it('says what to do when there are no skills', () => {
		const empty = html(createElement(SkillsEmpty, { onCreate: none, searching: false }))
		expect(empty).toContain(NO_SKILLS)
		expect(empty).toContain('Create with Namzu')
		expect(html(createElement(SkillsEmpty, { searching: true }))).toContain('No skills match')
	})
})

describe('a skill’s detail', () => {
	const detail = (skill: SkillRowModel, extra: Record<string, unknown> = {}) =>
		html(
			createElement(SkillDetail, {
				skill,
				now: NOW,
				tab: 'overview',
				onTab: none,
				onBack: none,
				onToggle: none,
				onTry: none,
				contents: createElement('p', null, 'files'),
				...extra,
			}),
		)
	it('has the back link, Try in chat, the switch, the tabs and the numbers', () => {
		const markup = detail(row({ uses7d: 4, lastUsedAt: day(2) }))
		expect(markup).toContain('Your skills')
		expect(markup).toContain('Try in chat')
		expect(markup).toContain('role="switch"')
		expect(markup).toContain('checked=""')
		expect(markup).toContain('Overview')
		expect(markup).toContain('Contents')
		expect(markup).toContain('· 3')
		expect(markup).toContain('runs · 7 days')
		expect(markup).toContain('>4<')
		expect(markup).toContain('2 days ago')
		expect(markup).toContain('~/.namzu/skills/notes')
		expect(markup).toContain('user · updated 3 days ago')
	})
	it('shows a dash where nothing was used', () => {
		expect(detail(row())).toContain('>—<')
	})
	it('has the switch off for an off skill', () => {
		expect(detail(row({ state: 'off' }))).not.toContain('checked=""')
	})
	it('says where a name-only skill is set, with the switch still on', () => {
		const markup = detail(row({ state: 'name-only' }))
		expect(markup).toContain('Set to name only in this project’s local settings')
		expect(markup).toContain('checked=""')
	})
	it('hides Contents when the engine gave no files', () => {
		expect(detail(row({ fileCount: 0 }))).not.toContain('Contents')
		expect(detail(row(), { contents: undefined })).not.toContain('Contents')
	})
	it('holds the switch of a plugin’s skill, with its reason', () => {
		const markup = detail(row({ tier: 'plugin', plugin: 'acme', place: 'plugin' }), {
			switchDisabled: 'Follows the acme plugin.',
		})
		expect(markup).toContain('Follows the acme plugin.')
		expect(markup).toContain('disabled=""')
		expect(markup).not.toContain('Actions for notes')
	})
})

describe('a skill’s contents', () => {
	const files = [
		{ path: 'SKILL.md', size: 10 },
		{ path: 'scripts/run.sh', size: 4 },
	]
	it('lists the files with the open one marked, and a rendered or source switch for markdown', () => {
		const markup = html(
			createElement(SkillContentsView, {
				files,
				path: 'SKILL.md',
				onPath: none,
				text: '# Title\n\nBody',
			}),
		)
		expect(markup).toContain('aria-current="true"')
		expect(markup).toContain('scripts')
		expect(markup).toContain('aria-label="Rendered"')
		expect(markup).toContain('aria-label="Source"')
		expect(markup).toContain('Title')
	})
	it('shows other files as plain monospace text, without the switch', () => {
		const markup = html(
			createElement(SkillContentsView, {
				files,
				path: 'scripts/run.sh',
				onPath: none,
				text: 'echo hi',
			}),
		)
		expect(markup).toContain('customize-source')
		expect(markup).not.toContain('aria-label="Rendered"')
	})
	it('says when the file was cut or cannot be read', () => {
		expect(
			html(
				createElement(SkillContentsView, {
					files,
					path: 'scripts/run.sh',
					onPath: none,
					text: 'x',
					truncated: true,
				}),
			),
		).toContain('first part')
		expect(
			html(
				createElement(SkillContentsView, {
					files,
					path: 'scripts/run.sh',
					onPath: none,
					textError: 'This file is binary.',
				}),
			),
		).toContain('This file is binary.')
	})
})

const plugin = (over: Partial<ComposerPlugin> = {}): ComposerPlugin => ({
	name: 'acme',
	version: '1.2.0',
	description: 'Acme tools.',
	scope: 'user',
	status: 'enabled',
	startupEnabled: true,
	updatedAt: day(10),
	skills: [{ name: 'deploy', description: 'Ship it.' }],
	servers: [{ name: 'acme-api' }],
	...over,
})
const live: ComposerPluginInventory = { plugins: [], live: true, canChange: true }
const inventory = (canChange = true) =>
	({
		changing: undefined,
		error: undefined,
		errorPlugin: undefined,
		canChange: () => canChange,
		clearError: vi.fn(),
		change: vi.fn(),
	}) as never

describe('the Plugins tab', () => {
	it('lists Installed with a count, a version chip, Off, and the place', () => {
		const markup = html(
			createElement(PluginsList, {
				plugins: [plugin(), plugin({ name: 'cold', status: 'disabled', scope: 'project' })],
				view: live,
				inventory: inventory(),
				now: NOW,
				onOpen: none,
			}),
		)
		expect(markup).toContain('Installed')
		expect(markup).toContain('customize-chip">1.2.0<')
		expect(markup).toContain('customize-chip">Off<')
		expect(markup).toContain('Yours · Acme tools.')
		expect(markup).toContain('This project · Acme tools.')
		expect(markup).toContain('Nov 17')
		expect(markup).toContain('aria-label="Actions for acme"')
	})
	it('says where plugins live when there are none, or asks for a trusted project', () => {
		expect(
			html(createElement(PluginsEmpty, { searching: false, disabled: false, onChooseSpace: none })),
		).toContain(NO_PLUGINS)
		expect(
			html(createElement(PluginsEmpty, { searching: false, disabled: true, onChooseSpace: none })),
		).toContain('Choose a space')
	})
})

describe('a plugin’s detail', () => {
	const detail = (tab: 'overview' | 'skills' | 'connectors', view = live, p = plugin()) =>
		html(
			createElement(PluginDetail, {
				plugin: p,
				view,
				inventory: inventory(),
				now: NOW,
				tab,
				onTab: none,
				onBack: none,
			}),
		)
	it('has the back link, the facts line, the switch and three tabs with counts', () => {
		const markup = detail('overview')
		expect(markup).toContain('Your plugins')
		expect(markup).toContain('Yours · 1.2.0 · 1 skill · updated on Nov 17')
		expect(markup).toContain('role="switch"')
		expect(markup).toContain('Skills')
		expect(markup).toContain('Connectors')
		expect(markup).toContain('· 1')
	})
	it('has the information as label and value rows', () => {
		const markup = detail('overview')
		for (const label of ['Installation', 'Version', 'Current status', 'Starts next time'])
			expect(markup).toContain(`<dt>${label}</dt>`)
		expect(markup).toContain('Acme tools.')
		expect(detail('overview', live, plugin({ startupError: 'Boom' }))).toContain('Startup error')
	})
	it('lists the skills as /name with the line about using them', () => {
		const markup = detail('skills')
		expect(markup).toContain('Use them by typing / in chat')
		expect(markup).toContain('/deploy')
		expect(markup).toContain('Ship it.')
	})
	it('lists the connector names', () => {
		expect(detail('connectors')).toContain('acme-api')
		expect(detail('connectors', live, plugin({ servers: undefined }))).toContain('no connectors')
	})
	it('keeps the rule that a change needs a live session, and says so', () => {
		const idle = { plugins: [], live: false, canChange: false }
		expect(detail('overview', idle)).toContain('Open a conversation to enable or disable plugins.')
		const busy = { plugins: [], live: true, canChange: false }
		expect(detail('overview', busy)).toContain('Finish the active work before changing plugins.')
	})
})

describe('the Connectors table', () => {
	const rows = [
		connectorRow({ name: 'good', origin: 'your-config', state: 'connected', detail: 'node' }),
		connectorRow({ name: 'wait', origin: 'project-file', state: 'waiting', fingerprint: 'f' }),
		connectorRow({
			name: 'bad',
			origin: 'this-project',
			state: 'failed',
			detail: 'https://example.com',
			reason: 'No answer.',
		}),
		connectorRow({ name: 'still', origin: 'your-config', state: 'idle' }),
	]
	const table = html(
		createElement(ConnectorsTable, {
			rows,
			approving: false,
			onOpen: none,
			onApprove: none,
			searching: false,
		}),
	)
	it('has the four columns', () => {
		for (const column of ['Connector', 'Type', 'Source', 'Status'])
			expect(table).toContain(`scope="col">${column}<`)
	})
	it('has a tick, an Approve button, a Failed word with the reason, and a dash', () => {
		expect(table).toContain('aria-label="Connected"')
		expect(table).toContain('aria-label="Approve wait"')
		expect(table).toContain('title="No answer."')
		expect(table).toContain('>Failed<')
		expect(table).toContain('>—<')
		expect(table).toContain('title="bad: No answer."')
	})
	it('says Local or Remote, and where each is set', () => {
		expect(table).toContain('>Local<')
		expect(table).toContain('>Remote<')
		expect(table).toContain('Your own settings')
		expect(table).toContain('.mcp.json in this project')
	})
	it('says there are none, with the way to add one', () => {
		const empty = html(
			createElement(ConnectorsTable, {
				rows: [],
				approving: false,
				onOpen: none,
				onApprove: none,
				onAdd: none,
				searching: false,
			}),
		)
		expect(empty).toContain(NO_CONNECTORS)
		expect(empty).toContain('Add custom connector')
	})
})
