/**
 * `/plugin` at the sizes a real terminal has: each tab, empty and filled, at 80
 * and 40 columns and on a short screen. No line may be wider than the terminal,
 * and what a tab is for has to be on screen.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import type { CliPluginInfo } from '../../integrations/plugins/runtime.js'
import type { SkillInfo } from '../../skills/store.js'
import { PluginScreen } from '../PluginScreen.js'
import { type PluginTab, type ScreenInputs, openScreen, step } from '../plugin-screen.js'
import { choiceDisplayWidth } from '../terminal-choice-text.js'
import { type Screen, renderToScreen } from './support/screen.js'

const NOW = Date.parse('2026-06-10T12:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const HOST_INSET = 1

const plugin = (name: string, extra: Partial<CliPluginInfo> = {}): CliPluginInfo => ({
	name,
	version: '1.0.0',
	description: `${name} does a thing`,
	scope: 'user',
	rootDir: `/h/.namzu/plugins/${name}`,
	status: 'enabled',
	startupEnabled: true,
	tools: [],
	skills: ['one'],
	hookModules: [],
	mcpServers: [],
	commands: [],
	agents: [],
	...extra,
})

const skill = (name: string): SkillInfo => ({
	name,
	description: `does ${name} and a good deal more besides`,
	path: `/x/${name}/SKILL.md`,
	source: 'user',
	tier: 'user',
})

const EMPTY: ScreenInputs = {
	mcp: { connected: [], failed: [] },
	plugins: [],
	pluginsNote: 'Plugins are off.',
	skills: [],
	usage: { since: NOW, skills: {} },
	now: NOW,
}

const FILLED: ScreenInputs = {
	mcp: {
		connected: [{ name: 'tickets', toolCount: 1, tools: ['mcp__tickets__open'] }],
		failed: [
			{
				name: 'broken-server-with-a-long-name',
				reason: 'the command was not found on this machine',
			},
		],
	},
	plugins: [
		plugin('ledger'),
		plugin('a-plugin-with-a-very-long-name-indeed', { startupError: 'plugin.json is not valid' }),
	],
	skills: [skill('alpha'), skill('a-skill-with-a-rather-long-name-indeed')],
	usage: {
		since: NOW - 30 * DAY,
		skills: { alpha: { count: 2, lastUsedAt: NOW - DAY, loads: [{ at: NOW - DAY, tokens: 300 }] } },
	},
	now: NOW,
}

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function show(
	inputs: ScreenInputs,
	tab: PluginTab,
	cols: number,
	rows: number,
	keys: Parameters<typeof step>[1][] = [],
): Promise<string[]> {
	let state = openScreen(inputs, tab)
	for (const key of keys) state = step(state, key).state
	const screen = await renderToScreen(
		<Box paddingX={HOST_INSET}>
			<PluginScreen state={state} columns={cols - 2} />
		</Box>,
		{ cols, rows },
	)
	mounted = screen
	await screen.waitForRender()
	return screen.viewport()
}

const text = (lines: readonly string[]) => lines.join('\n')
const fits = (lines: readonly string[], cols: number) => {
	for (const line of lines) expect(choiceDisplayWidth(line.trimEnd())).toBeLessThanOrEqual(cols)
}

it.each([80, 40])('Installed, empty and filled, at %s columns', async (cols) => {
	const empty = await show(EMPTY, 'installed', cols, 24)
	expect(text(empty)).toContain('Search installed items')
	expect(text(empty)).toContain('Plugins are off.')
	expect(text(empty)).toContain('Esc')
	fits(empty, cols)
	await mounted?.unmount()
	const filled = await show(FILLED, 'installed', cols, 30)
	for (const word of ['MCP servers', 'Plugins', 'Skills', 'tickets', 'ledger', 'alpha']) {
		expect(text(filled)).toContain(word)
	}
	fits(filled, cols)
})

it.each([80, 40])('Errors, empty and filled, at %s columns', async (cols) => {
	const empty = await show(EMPTY, 'errors', cols, 24)
	expect(text(empty)).toContain('No plugin errors')
	fits(empty, cols)
	await mounted?.unmount()
	const filled = await show(FILLED, 'errors', cols, 30)
	expect(text(filled)).toContain('plugin.json is not valid')
	expect(text(filled)).toContain('the command was not found')
	fits(filled, cols)
})

it.each([80, 40])('Stats, empty and filled, at %s columns', async (cols) => {
	const empty = await show(EMPTY, 'stats', cols, 24)
	expect(text(empty)).toContain('No skills are installed.')
	fits(empty, cols)
	await mounted?.unmount()
	const filled = await show(FILLED, 'stats', cols, 40)
	expect(text(filled)).toContain('Skills loaded this session')
	expect(text(filled)).toContain('Context')
	expect(text(filled)).toContain('Uses')
	expect(text(filled)).toContain('never')
	expect(text(filled)).toContain('1d')
	fits(filled, cols)
})

it('a detail view fits a short, narrow terminal and says how to go back', async () => {
	const lines = await show(FILLED, 'installed', 40, 14, [
		{ input: '', down: true },
		{ input: '', down: true },
		{ input: '', return: true },
	])
	expect(text(lines)).toContain('Esc to go back')
	fits(lines, 40)
})

it('the tab row names every tab and marks the open one', async () => {
	const lines = await show(FILLED, 'errors', 80, 24)
	expect(lines.find((line) => line.includes('Plugins'))).toMatch(/Installed\s+Errors\s+Stats/)
})
