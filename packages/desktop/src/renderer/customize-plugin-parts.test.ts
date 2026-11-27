import { type ReactElement, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { MarketplaceListView, MarketplacePluginView } from '../shared/customize-protocol.js'
import type { ComposerPlugin, ComposerPluginInventory } from './composer-plugins.js'
import {
	AddMarketplaceForm,
	ConsentCard,
	ConsentFlow,
	DiscoverGrid,
	MarketplacesList,
	UploadPluginPage,
} from './customize-plugin-parts.js'
import { consentSections } from './customize-plugins-model.js'
import { PluginDetail, PluginsList, pluginEntries } from './customize-plugins.js'
import type { PluginActions } from './use-plugin-actions.js'

const html = (node: ReactElement) => renderToStaticMarkup(node)
const none = () => {}
const quiet = { onEvent: () => none }
const NOW = Date.parse('2026-11-27T12:00:00.000Z')

const plugin = (over: Partial<ComposerPlugin> = {}): ComposerPlugin => ({
	name: 'ledger',
	version: '1.0.0',
	description: 'Keep the books.',
	scope: 'user',
	status: 'enabled',
	startupEnabled: true,
	id: 'ledger@team-tools',
	marketplace: 'team-tools',
	installed: ['user'],
	...over,
})
const live: ComposerPluginInventory = { plugins: [], live: true, canChange: true }
const idle: ComposerPluginInventory = { plugins: [], live: false, canChange: false }
const inventory = (canChange = true) =>
	({
		changing: undefined,
		error: undefined,
		errorPlugin: undefined,
		canChange: () => canChange,
		clearError: vi.fn(),
		change: vi.fn(),
	}) as never
const actions = (over: Partial<PluginActions> = {}): PluginActions => ({
	states: {},
	clearPendingUpdate: none,
	setSaved: vi.fn(async () => {}),
	check: vi.fn(async () => {}),
	update: vi.fn(async () => {}),
	remove: vi.fn(async () => {}),
	updateMarket: vi.fn(async () => {}),
	removeMarket: vi.fn(async () => {}),
	...over,
})
const row = (over: Partial<PluginActions> = {}) => ({
	actions: actions(over),
	onToggle: vi.fn(),
	onRemove: vi.fn(),
})

describe('the Add marketplace dialog body', () => {
	const form = (api: Partial<Parameters<typeof AddMarketplaceForm>[0]['api']> = {}) =>
		html(
			createElement(AddMarketplaceForm, {
				api: { ...quiet, ...api },
				onClose: none,
				onAdded: none,
			}),
		)
	it('shows the notice, the URL field with its placeholder and help, and Add off until an address is read', () => {
		const markup = form({ choosePluginFolder: async () => [] })
		expect(markup).toContain(
			'Only add marketplaces you trust. Namzu does not control their plugins, and their owners can change them later.',
		)
		expect(markup).toContain('>URL<')
		expect(markup).toContain('placeholder="owner/repo or a Git address"')
		expect(markup).toContain(
			'A GitHub owner/repo, a Git repository address, a marketplace.json address, or a folder on this computer.',
		)
		expect(markup).toContain('Choose a folder')
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Add<\/button>/)
		expect(markup).toContain('>Cancel<')
	})
	it('has no folder link where the app cannot open the dialog', () => {
		expect(form()).not.toContain('Choose a folder')
	})
})

describe('the Upload a plugin page', () => {
	const page = () =>
		html(createElement(UploadPluginPage, { api: quiet, onBack: none, onDone: none }))
	it('has the words of the design and Install off with its reason', () => {
		const markup = page()
		for (const text of [
			'Your plugins',
			'Upload a plugin',
			'Add a plugin to this computer from a .zip or .plugin file, or a folder.',
			'Only upload plugins you trust. Namzu cannot check what they do.',
			'Plugin file',
			'Drag and drop a plugin file here, or ',
			'browse',
			'Choose a folder',
			'The archive must contain a plugin manifest (for the common layout, .claude-plugin/plugin.json), or a top-level SKILL.md.',
			'Choose a file to continue.',
			'>Cancel<',
		])
			expect(markup).toContain(text)
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Install<\/button>/)
	})
})

describe('the consent card', () => {
	const surface = {
		hooks: [{ event: 'PostToolUse', type: 'command', run: 'log.sh' }],
		fileHooks: [],
		mcpLocal: [],
		mcpRemote: [
			{
				name: 'cloud',
				origin: 'https://mcp.example.com',
				transport: 'http',
				sendsEnv: [],
				headers: ['Authorization'],
			},
		],
		modules: [],
		allowedTools: [],
		scripts: [],
		scriptsTotal: 0,
		unpinnedDownload: false,
	}
	const digest = `ab${'0'.repeat(60)}cd`
	const card = (extra: Partial<Parameters<typeof ConsentCard>[0]> = {}) =>
		html(
			createElement(ConsentCard, {
				name: 'ledger',
				version: '1.0.0',
				sections: consentSections(surface, { skills: ['books'], commands: [], agents: [] }, [
					{ level: 'ignored', code: 'sidecar-shipped', message: 'extra.json is not used.' },
				]),
				digest,
				...extra,
			}),
		)
	it('shows the three groups, the warning and the digest in small print', () => {
		const markup = card()
		for (const text of [
			'ledger',
			'1.0.0',
			'This plugin adds',
			'Skills: books',
			'Runs on this computer',
			'Hook: After a tool runs: <code class="customize-consent-code">log.sh</code>',
			'Server cloud (asks you before it connects; headers: Authorization): <code class="customize-consent-code">https://mcp.example.com</code>',
			'Not used by Namzu',
			'extra.json is not used.',
			'Plugins run code on your computer, with access to your files. Install only what you trust.',
			'ab000000…000000cd',
		])
			expect(markup).toContain(text)
		expect(markup).toContain('data-muted="true"')
	})
	it('asks to turn plugin loading on only when it is off, unticked', () => {
		expect(card()).not.toContain('Turn on plugin loading')
		const markup = card({ loading: { off: true, checked: false, onChange: none } })
		expect(markup).toContain('Turn on plugin loading (needed for plugins to run)')
		expect(markup).not.toContain('checked=""')
		expect(card({ loading: { off: true, checked: true, onChange: none } })).toContain('checked=""')
	})
	it('leads with what changed for an update', () => {
		const markup = card({ changes: ['It now runs a hook on PostToolUse.'] })
		expect(markup).toContain('What changed')
		expect(markup).toContain('It now runs a hook on PostToolUse.')
		expect(markup.indexOf('What changed')).toBeLessThan(markup.indexOf('This plugin adds'))
	})
})

describe('the consent flow before the plugin is read', () => {
	it('shows Install for, Yours and This project, and Install off while reading', () => {
		const markup = html(
			createElement(ConsentFlow, {
				api: { ...quiet, planPlugin: () => new Promise<null>(() => {}) },
				source: { id: 'ledger@team-tools' },
				projectId: undefined,
				onInstalled: none,
				onCancel: none,
			}),
		)
		expect(markup).toContain('Install for')
		expect(markup).toContain('Yours')
		expect(markup).toContain('This project')
		expect(markup).toContain('Open a trusted project folder to install plugins there.')
		expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Install<\/button>/)
	})
})

const markets = (over: Partial<MarketplaceListView> = {}): MarketplaceListView => ({
	marketplaces: [
		{
			name: 'team-tools',
			source: '/work/market',
			kind: 'path',
			lastUpdated: '2026-11-26T12:00:00.000Z',
			autoUpdate: false,
			plugins: 2,
			installed: 1,
		},
	],
	declaredByProject: [],
	problems: [],
	...over,
})

describe('the Marketplaces list', () => {
	it('shows a letter tile, the name, the count, the source and when it was updated, with a menu', () => {
		const markup = html(
			createElement(MarketplacesList, {
				view: markets(),
				now: NOW,
				updating: undefined,
				onUpdate: none,
				onRemove: none,
			}),
		)
		expect(markup).toContain('Marketplaces')
		expect(markup).toContain('>T<')
		expect(markup).toContain('team-tools')
		expect(markup).toContain('1 installed')
		expect(markup).toContain('2 plugins · /work/market')
		expect(markup).toContain('aria-label="Actions for marketplace team-tools"')
	})
	it('marks a marketplace that needs attention and one that is being updated', () => {
		const view = markets()
		const first = view.marketplaces[0]
		if (!first) throw new Error('fixture')
		const markup = html(
			createElement(MarketplacesList, {
				view: { ...view, marketplaces: [{ ...first, problem: 'Its file is gone.' }] },
				now: NOW,
				updating: 'team-tools',
				onUpdate: none,
				onRemove: none,
			}),
		)
		expect(markup).toContain('Needs attention')
		expect(markup).toContain('Its file is gone.')
		expect(markup).toContain('aria-label="Updating"')
	})
})

describe('Discover', () => {
	const offer = (over: Partial<MarketplacePluginView> = {}): MarketplacePluginView => ({
		name: 'ledger',
		id: 'ledger@team-tools',
		description: 'Keep the books.',
		version: '1.0.0',
		installable: true,
		installedAt: [],
		...over,
	})
	const grid = (available: Parameters<typeof DiscoverGrid>[0]['available'], query = '') =>
		html(createElement(DiscoverGrid, { view: markets(), available, query, onAdd: none }))
	it('draws a card per plugin with its name, text, source and a + that names it', () => {
		const markup = grid({
			'team-tools': { marketplace: 'team-tools', plugins: [offer()], warnings: [] },
		})
		expect(markup).toContain('From team-tools')
		expect(markup).toContain('Keep the books.')
		expect(markup).toContain('from team-tools · 1.0.0')
		expect(markup).toContain('aria-label="Add ledger"')
	})
	it('shows a check instead of the + for one that is installed, and a reason for one that cannot be', () => {
		const markup = grid({
			'team-tools': {
				marketplace: 'team-tools',
				plugins: [
					offer({ installedAt: ['user'] }),
					offer({
						name: 'odd',
						id: 'odd@team-tools',
						installable: false,
						reason: 'It has no manifest.',
					}),
				],
				warnings: [],
			},
		})
		expect(markup).toContain('aria-label="ledger is installed"')
		expect(markup).toContain('title="It has no manifest."')
		expect(markup).toMatch(
			/<button[^>]*disabled=""[^>]*aria-label="Add odd"|aria-label="Add odd"[^>]*disabled=""/,
		)
	})
	it('says it is reading, shows a marketplace error, and filters by the search', () => {
		expect(grid({})).toContain('Reading team-tools…')
		expect(grid({ 'team-tools': { error: 'Its file could not be read.' } })).toContain(
			'Its file could not be read.',
		)
		const found = { 'team-tools': { marketplace: 'team-tools', plugins: [offer()], warnings: [] } }
		expect(grid(found, 'zzz')).toContain('No plugins match your search.')
		expect(grid(found, 'books')).toContain('aria-label="Add ledger"')
	})
	it('says so when the marketplaces offer nothing', () => {
		expect(
			grid({ 'team-tools': { marketplace: 'team-tools', plugins: [], warnings: [] } }),
		).toContain('These marketplaces offer no plugins yet.')
	})
})

describe('the plugin rows once the engine manages plugins', () => {
	const list = (plugins: ComposerPlugin[], r = row()) =>
		html(
			createElement(PluginsList, {
				plugins,
				view: live,
				inventory: inventory(),
				now: NOW,
				onOpen: none,
				row: r,
			}),
		)
	it('groups by marketplace and shows an update chip from a check or from the engine', () => {
		const markup = list(
			[
				plugin(),
				plugin({ name: 'hand', id: undefined, marketplace: undefined, installed: undefined }),
			],
			row({
				states: {
					'ledger@team-tools': { kind: 'available', version: '1.3.0', changesExecutable: false },
				},
			}),
		)
		expect(markup).toContain('From team-tools')
		expect(markup).toContain('>Installed<')
		expect(markup).toContain('Version 1.3.0 is available')
		expect(list([plugin({ updateKnown: true })])).toContain('Update available')
	})
	it('lists the menu in the order of the design, for each kind of plugin', () => {
		const labels = (p: ComposerPlugin, r = row(), view = live) =>
			pluginEntries(p, view, inventory(), r, none).map((entry) => entry.label)
		expect(labels(plugin())).toEqual(['Turn off', 'Check for updates', 'Details', 'Remove'])
		expect(labels(plugin({ startupEnabled: false, status: 'disabled' }))[0]).toBe('Turn on')
		// Off when no conversation is open: the saved record says so.
		expect(labels(plugin({ startupEnabled: false }), row(), idle)[0]).toBe('Turn on')
		expect(
			labels(
				plugin(),
				row({
					states: {
						'ledger@team-tools': { kind: 'available', version: '2', changesExecutable: true },
					},
				}),
			),
		).toEqual(['Turn off', 'Check for updates', 'Update', 'Details', 'Remove'])
		// A plugin placed by hand cannot be removed, and says why it cannot be checked.
		const placed = pluginEntries(
			plugin({ id: undefined, marketplace: undefined, installed: undefined }),
			live,
			inventory(),
			row(),
			none,
		)
		expect(placed.map((entry) => entry.label)).toEqual(['Turn off', 'Check for updates', 'Details'])
		expect(placed[1]).toMatchObject({ disabled: true })
		expect(placed[1]?.title).toContain('no source')
	})
	it('keeps the old menu without the new entries where the engine cannot manage plugins', () => {
		expect(
			pluginEntries(plugin(), live, inventory(), undefined, none).map((entry) => entry.label),
		).toEqual(['Turn off', 'Details'])
	})
	it('turns a checking row off its menu entry', () => {
		const entries = pluginEntries(
			plugin(),
			live,
			inventory(),
			row({ states: { 'ledger@team-tools': { kind: 'checking' } } }),
			none,
		)
		expect(entries.find((entry) => entry.label === 'Check for updates')).toMatchObject({
			disabled: true,
		})
	})
})

describe('a plugin detail with the new actions', () => {
	const detail = (p: ComposerPlugin, r = row(), view = live) =>
		html(
			createElement(PluginDetail, {
				plugin: p,
				view,
				inventory: inventory(),
				now: NOW,
				tab: 'overview',
				onTab: none,
				onBack: none,
				row: r,
			}),
		)
	it('shows the last check and an Update button when one is available', () => {
		const markup = detail(
			plugin(),
			row({
				states: {
					'ledger@team-tools': { kind: 'available', version: '1.3.0', changesExecutable: false },
				},
			}),
		)
		expect(markup).toContain('Version 1.3.0 is available')
		expect(markup).toContain('>Update<')
		expect(
			detail(
				plugin(),
				row({ states: { 'ledger@team-tools': { kind: 'current', version: '1.0.0' } } }),
			),
		).toContain('Up to date')
	})
	it('tells what to do about a folder placed by hand', () => {
		const markup = detail(plugin({ id: undefined, marketplace: undefined, installed: undefined }))
		expect(markup).toContain(
			'This plugin is a folder you placed in .namzu/plugins. Namzu will not delete it; remove the folder yourself.',
		)
	})
	it('keeps the switch usable without a conversation for a plugin Namzu installed', () => {
		const markup = detail(plugin(), row(), idle)
		expect(markup).toMatch(/role="switch"(?![^>]*disabled)/)
	})
})
