import { describe, expect, it } from 'vitest'

import type { CliPluginInfo } from '../integrations/plugins/runtime.js'
import type { SkillInfo } from '../skills/store.js'
import {
	type PluginScreenState,
	type ScreenInputs,
	detailActions,
	detailItem,
	detailLines,
	errorEntries,
	layoutItem,
	listLines,
	nameColumn,
	openScreen,
	refreshScreen,
	statsColumns,
	statsLine,
	statsRows,
	step,
	visibleItems,
} from './plugin-screen.js'
import { choiceDisplayWidth } from './terminal-choice-text.js'

const NOW = Date.parse('2026-06-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000

const plugin = (name: string, extra: Partial<CliPluginInfo> = {}): CliPluginInfo => ({
	name,
	version: '1.0.0',
	description: `${name} does a thing`,
	scope: 'project',
	rootDir: `/w/.namzu/plugins/${name}`,
	status: 'enabled',
	startupEnabled: true,
	tools: [],
	skills: [],
	hookModules: [],
	mcpServers: [],
	commands: [],
	agents: [],
	...extra,
})

const skill = (name: string, extra: Partial<SkillInfo> = {}): SkillInfo => ({
	name,
	description: `does ${name} and a good deal more besides`,
	path: `/x/${name}/SKILL.md`,
	source: 'project',
	tier: 'project',
	...extra,
})

const inputs = (extra: Partial<ScreenInputs> = {}): ScreenInputs => ({
	mcp: {
		connected: [
			{ name: 'tickets', toolCount: 2, tools: ['mcp__tickets__open', 'mcp__tickets__close'] },
		],
		failed: [{ name: 'broken', reason: 'the command was not found' }],
	},
	plugins: [plugin('ledger')],
	skills: [skill('alpha'), skill('beta')],
	usage: { since: NOW - 30 * DAY, skills: {} },
	now: NOW,
	...extra,
})

const press = (
	state: PluginScreenState,
	...keys: Parameters<typeof step>[1][]
): PluginScreenState => keys.reduce((s, key) => step(s, key).state, state)

const RIGHT = { input: '', right: true }
const LEFT = { input: '', left: true }
const DOWN = { input: '', down: true }
const ENTER = { input: '', return: true }
const ESC = { input: '', escape: true }

describe('tabs', () => {
	it('opens on Installed and moves with the arrows, around the ends', () => {
		let s = openScreen(inputs())
		expect(s.tab).toBe('installed')
		s = press(s, RIGHT)
		expect(s.tab).toBe('errors')
		s = press(s, RIGHT)
		expect(s.tab).toBe('stats')
		s = press(s, RIGHT)
		expect(s.tab).toBe('installed')
		s = press(s, LEFT)
		expect(s.tab).toBe('stats')
	})

	it('Esc closes from a tab and leaves a detail view first', () => {
		const s = openScreen(inputs())
		expect(step(s, ESC).close).toBe(true)
		const open = press(s, ENTER)
		expect(detailItem(open)).toBeDefined()
		const back = step(open, ESC)
		expect(back.close).toBe(false)
		expect(detailItem(back.state)).toBeUndefined()
		expect(step(back.state, ESC).close).toBe(true)
	})

	it('switching tabs leaves a detail view', () => {
		const s = press(openScreen(inputs()), ENTER, RIGHT)
		expect(s.tab).toBe('errors')
		expect(detailItem(s)).toBeUndefined()
	})
})

describe('Installed', () => {
	it('lists servers, plugins and skills under their headings', () => {
		const lines = listLines(openScreen(inputs()))
		const headings = lines.flatMap((line) => (line.kind === 'heading' ? [line.text] : []))
		expect(headings).toEqual(['MCP servers', 'Plugins', 'Skills'])
		expect(visibleItems(openScreen(inputs())).map((item) => item.name)).toEqual([
			'broken',
			'tickets',
			'ledger',
			'alpha',
			'beta',
		])
	})

	it('says why there are no plugins, and shows nothing for a heading the search empties', () => {
		const empty = openScreen(inputs({ plugins: [], pluginsNote: 'Plugins are off.' }))
		expect(listLines(empty)).toContainEqual({ kind: 'note', text: 'Plugins are off.' })
		const searched = press(empty, { input: '/' }, { input: 'a' }, { input: 'l' })
		const headings = listLines(searched).flatMap((line) =>
			line.kind === 'heading' ? [line.text] : [],
		)
		expect(headings).toEqual(['Skills'])
	})

	it('filters by name, kind and place, and Esc in the box clears it without closing', () => {
		let s = press(
			openScreen(inputs()),
			{ input: '/' },
			{ input: 'p' },
			{ input: 'l' },
			{ input: 'u' },
		)
		expect(visibleItems(s).map((item) => item.name)).toEqual(['ledger'])
		const out = step(s, ESC)
		expect(out.close).toBe(false)
		expect(out.state.query).toBe('')
		s = out.state
		expect(visibleItems(s)).toHaveLength(5)
	})

	it('Space on a plugin asks for the opposite state; elsewhere it explains', () => {
		const s = openScreen(inputs())
		const onPlugin = press(s, DOWN, DOWN)
		expect(step(onPlugin, { input: ' ' }).effect).toEqual({
			kind: 'plugin-enable',
			name: 'ledger',
			enabled: false,
		})
		const onSkill = press(s, DOWN, DOWN, DOWN)
		const out = step(onSkill, { input: ' ' })
		expect(out.effect).toBeUndefined()
		expect(out.state.notice).toContain('/skills')
		const onServer = step(s, { input: ' ' })
		expect(onServer.state.notice).toContain('/mcp')
	})

	it('keys wait while a change is under way', () => {
		const busy = { ...openScreen(inputs()), busy: 'Disabling plugin…' }
		expect(step(busy, ESC)).toEqual({ state: busy, close: false })
	})
})

describe('detail views', () => {
	it('a plugin offers the per-conversation switch and the remembered one', () => {
		let s = press(openScreen(inputs()), DOWN, DOWN, ENTER)
		const item = detailItem(s)
		expect(item?.name).toBe('ledger')
		if (!item) return
		const actions = detailActions(item, false)
		expect(actions.map((action) => action.id)).toEqual(['disable', 'remember', 'back'])
		// "Keep enabled after restart" is already so: refused with a reason.
		s = press(s, DOWN)
		expect(step(s, ENTER).state.notice).toContain('already')
		expect(step(s, ENTER).effect).toBeUndefined()
		s = press(
			openScreen(inputs({ plugins: [plugin('ledger', { startupEnabled: false })] })),
			DOWN,
			DOWN,
			ENTER,
			DOWN,
		)
		expect(step(s, ENTER).effect).toEqual({ kind: 'plugin-remember', name: 'ledger' })
		const first = press(openScreen(inputs()), DOWN, DOWN, ENTER)
		expect(step(first, ENTER).effect).toEqual({
			kind: 'plugin-enable',
			name: 'ledger',
			enabled: false,
		})
	})

	it('a server shows its status and command, its tools on request, and Back returns', () => {
		const withSpec = inputs({
			mcpServers: { tickets: { command: 'node', args: ['server.js'] } },
		})
		let s = press(openScreen(withSpec), DOWN, ENTER)
		const item = detailItem(s)
		expect(item?.name).toBe('tickets')
		if (!item) return
		const lines = detailLines(item, false, NOW)
		expect(lines).toContain('Status: ✓ connected')
		expect(lines).toContain('Command: node server.js')
		expect(lines.join('\n')).not.toContain('mcp__tickets__open')
		s = press(s, ENTER)
		expect(s.toolsOpen).toBe(true)
		expect(detailLines(item, true, NOW).join('\n')).toContain('mcp__tickets__open')
		s = press(s, DOWN, ENTER)
		expect(detailItem(s)).toBeUndefined()
	})

	it('a server address loses its query string and credentials', () => {
		const s = openScreen(
			inputs({
				mcp: { connected: [{ name: 'web', toolCount: 0, tools: [] }], failed: [] },
				mcpServers: { web: { url: 'https://user:secret@example.test/mcp?token=abc' } },
			}),
		)
		const item = visibleItems(s)[0]
		if (!item) throw new Error('no item')
		const text = detailLines(item, false, NOW).join('\n')
		expect(text).toContain('https://example.test/mcp')
		expect(text).not.toContain('secret')
		expect(text).not.toContain('token')
	})

	it('a skill shows its file, place and use, and only Back', () => {
		const s = press(openScreen(inputs()), DOWN, DOWN, DOWN, ENTER)
		const item = detailItem(s)
		expect(item?.kind).toBe('skill')
		if (!item) return
		expect(detailActions(item, false).map((action) => action.id)).toEqual(['back'])
		const text = detailLines(item, false, NOW).join('\n')
		expect(text).toContain('File: /x/alpha/SKILL.md')
		expect(text).toContain('Used: never used')
	})

	it('refreshing keeps the tab and drops a detail view whose row is gone', () => {
		const s = press(openScreen(inputs()), DOWN, DOWN, ENTER)
		const refreshed = refreshScreen(s, inputs({ plugins: [] }))
		expect(refreshed.tab).toBe('installed')
		expect(detailItem(refreshed)).toBeUndefined()
	})
})

describe('Errors', () => {
	it('is empty when nothing failed', () => {
		expect(
			errorEntries(inputs({ mcp: { connected: [], failed: [] }, plugins: [plugin('ledger')] })),
		).toEqual([])
	})

	it('lists a failed server, a plugin with an error and a skill that does not parse, each with guidance', () => {
		const entries = errorEntries(
			inputs({
				plugins: [plugin('ledger', { startupError: 'plugin.json is not valid' })],
				skills: [skill('broken-skill', { problem: 'the frontmatter does not parse' }), skill('ok')],
			}),
		)
		expect(entries.map((entry) => entry.title)).toEqual([
			'Plugin ledger',
			'MCP server broken',
			'Skill broken-skill',
		])
		for (const entry of entries) {
			expect(entry.message).not.toBe('')
			expect(entry.guidance).not.toBe('')
		}
	})

	it('a skill turned off is not an error', () => {
		const off = skill('quiet', {
			disabled: true,
			problem: 'disabled by skills.disabled in the config',
		})
		expect(errorEntries(inputs({ skills: [off] })).map((entry) => entry.title)).toEqual([
			'MCP server broken',
		])
	})
})

describe('Stats', () => {
	it('shows a dash and zero for a skill never loaded, and the record for one that was', () => {
		const rows = statsRows(
			inputs({
				usage: {
					since: NOW - 30 * DAY,
					skills: {
						beta: {
							count: 3,
							lastUsedAt: NOW - 2 * DAY,
							loads: [
								{ at: NOW - 2 * DAY, tokens: 400 },
								{ at: NOW - 20 * DAY, tokens: 999 },
							],
						},
					},
				},
			}),
		)
		const alpha = rows.find((row) => row.name === 'alpha')
		const beta = rows.find((row) => row.name === 'beta')
		expect(alpha).toMatchObject({ sevenDay: '-', uses: '0', last: 'never' })
		expect(beta).toMatchObject({ sevenDay: '~400', uses: '3', last: '2d' })
		// Least used first.
		expect(rows.map((row) => row.name)).toEqual(['alpha', 'beta'])
	})

	it('a skill kept out of the listing costs nothing', () => {
		const rows = statsRows(
			inputs({ skills: [skill('hidden', { state: 'user-only', invocation: 'operator' })] }),
		)
		expect(rows[0]?.context).toBe('-')
	})

	it('fits 80 columns with every column, and drops Source, then 7d tokens, as the width shrinks', () => {
		const rows = statsRows(
			inputs({
				skills: [skill('a-skill-with-a-rather-long-name-indeed', { tier: 'user' }), skill('beta')],
			}),
		)
		const ids = (width: number) => statsColumns(rows, width).map((column) => column.id)
		expect(ids(78)).toEqual(['name', 'place', 'context', 'sevenDay', 'uses', 'last'])
		expect(ids(66)).toEqual(['name', 'context', 'sevenDay', 'uses', 'last'])
		expect(ids(40)).toEqual(['name', 'context', 'uses', 'last'])
		for (const width of [118, 78, 66, 40]) {
			const columns = statsColumns(rows, width)
			for (const row of [undefined, ...rows]) {
				expect(choiceDisplayWidth(statsLine(columns, row))).toBeLessThanOrEqual(width)
			}
		}
	})
})

describe('row layout', () => {
	it('is never wider than the terminal, at 120, 80, 60 and 40 columns', () => {
		const s = openScreen(
			inputs({
				skills: [skill('a-skill-with-a-rather-long-name-indeed', { tier: 'user' })],
				plugins: [
					plugin('a-plugin-with-a-long-name-as-well', { startupError: 'bad', skills: ['x', 'y'] }),
				],
			}),
		)
		const items = visibleItems(s)
		for (const width of [118, 78, 58, 38]) {
			const nameWidth = nameColumn(items, width)
			for (const item of items) {
				for (const selected of [true, false]) {
					const row = layoutItem(item, selected, nameWidth, width, NOW)
					expect(choiceDisplayWidth(row.lead + row.name + row.kind + row.meta)).toBeLessThanOrEqual(
						width,
					)
				}
			}
		}
	})

	it('names the kind and the place at a width that has room', () => {
		const s = openScreen(inputs())
		const item = visibleItems(s).find((entry) => entry.name === 'alpha')
		if (!item) throw new Error('no item')
		const row = layoutItem(item, false, 10, 100, NOW)
		expect(row.kind.trim()).toBe('Skill')
		expect(row.meta).toContain('project')
		expect(row.meta).toContain('never used')
	})
})
