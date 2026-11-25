/**
 * The `/plugin` screen as data: the tab row, what each tab lists, the cursor,
 * the search, a detail view per row, one pure step per key, and how a line is
 * laid out in a given width.
 *
 * The component (`PluginScreen.tsx`) only draws what this returns, and App only
 * forwards keys and carries out the one thing a key can ask the session for
 * (`effect`). Nothing here reads a file or the session: everything it shows
 * arrives in `ScreenInputs`, so each tab, each key and each width is testable
 * without a terminal.
 *
 * Tabs: Installed (tool servers, plugins, skills), Errors (what failed to
 * load, with what to do about it) and Stats (what each skill costs the
 * listing and how often it has been used). A Discover or Marketplaces tab is
 * not here: Namzu reads plugins from two folders and has no catalog to list.
 */

import type { McpServersConfig } from '../integrations/mcp/servers.js'
import type { CliPluginInfo } from '../integrations/plugins/runtime.js'
import {
	type SkillState,
	formatTokenCost,
	skillListingTokens,
	skillStateOf,
} from '../skills/overrides.js'
import { type SkillInfo, isOffProblem, skillTierLabel } from '../skills/store.js'
import {
	type SkillUsage,
	type SkillUse,
	ageWord,
	sevenDayTokens,
	usageWords,
} from '../skills/usage.js'
import { pluginDetailRows } from './plugin-view.js'
import {
	choiceDisplayWidth,
	truncateAtSeparator,
	truncateChoiceText,
	wrapChoiceText,
} from './terminal-choice-text.js'

// ---------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------

export type PluginTab = 'installed' | 'errors' | 'stats'

export const PLUGIN_TABS: readonly { readonly id: PluginTab; readonly label: string }[] = [
	{ id: 'installed', label: 'Installed' },
	{ id: 'errors', label: 'Errors' },
	{ id: 'stats', label: 'Stats' },
]

export interface McpInput {
	readonly connected: readonly {
		readonly name: string
		readonly toolCount: number
		readonly tools: readonly string[]
	}[]
	readonly failed: readonly { readonly name: string; readonly reason: string }[]
	readonly pending?: readonly string[]
}

/** Everything the screen shows, as the host read it when the screen opened or changed. */
export interface ScreenInputs {
	readonly mcp: McpInput | null
	/** The configured tool servers, for the command or address a detail view shows. */
	readonly mcpServers?: McpServersConfig
	readonly plugins: readonly CliPluginInfo[]
	/** Why no plugin is loaded when none is: plugin loading off, discovery off, nothing found. */
	readonly pluginsNote?: string
	readonly skills: readonly SkillInfo[]
	readonly usage: SkillUsage
	readonly now: number
}

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

export type ItemKind = 'mcp' | 'plugin' | 'skill'

export type McpStatus = 'connected' | 'connecting' | 'failed'

export interface McpItem {
	readonly kind: 'mcp'
	readonly id: string
	readonly name: string
	readonly status: McpStatus
	readonly reason?: string
	readonly tools: readonly string[]
	/** The command line or address, without its credentials. */
	readonly where?: string
}

export interface PluginItem {
	readonly kind: 'plugin'
	readonly id: string
	readonly name: string
	readonly plugin: CliPluginInfo
}

export interface SkillItem {
	readonly kind: 'skill'
	readonly id: string
	readonly name: string
	readonly place: string
	readonly tokens: number
	readonly state: SkillState
	readonly description: string
	readonly path: string
	readonly problem?: string
	readonly use?: SkillUse
}

export type ScreenItem = McpItem | PluginItem | SkillItem

/** The word each kind of row carries. */
const KIND_WORD: Record<ItemKind, string> = { mcp: 'MCP', plugin: 'Plugin', skill: 'Skill' }

/** The address of a server without what could be a credential in it: no userinfo, no query. */
function safeAddress(url: string): string {
	try {
		const parsed = new URL(url)
		return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`
	} catch {
		return url.split('?')[0] ?? url
	}
}

function mcpItems(inputs: ScreenInputs): readonly McpItem[] {
	const spec = (name: string): string | undefined => {
		const found = inputs.mcpServers?.[name]
		if (!found) return undefined
		if (found.command !== undefined) return [found.command, ...(found.args ?? [])].join(' ')
		return found.url !== undefined ? safeAddress(found.url) : undefined
	}
	const mcp = inputs.mcp
	if (!mcp) return []
	const items: McpItem[] = []
	for (const server of mcp.connected) {
		const where = spec(server.name)
		items.push({
			kind: 'mcp',
			id: `mcp:${server.name}`,
			name: server.name,
			status: 'connected',
			tools: server.tools,
			...(where ? { where } : {}),
		})
	}
	for (const server of mcp.failed) {
		const where = spec(server.name)
		items.push({
			kind: 'mcp',
			id: `mcp:${server.name}`,
			name: server.name,
			status: 'failed',
			reason: server.reason,
			tools: [],
			...(where ? { where } : {}),
		})
	}
	for (const name of mcp.pending ?? []) {
		const where = spec(name)
		items.push({
			kind: 'mcp',
			id: `mcp:${name}`,
			name,
			status: 'connecting',
			tools: [],
			...(where ? { where } : {}),
		})
	}
	return items.sort((a, b) => a.name.localeCompare(b.name))
}

function skillItems(inputs: ScreenInputs): readonly SkillItem[] {
	return inputs.skills
		.map((info): SkillItem => {
			const use = inputs.usage.skills[info.name]
			return {
				kind: 'skill',
				id: `skill:${info.name}`,
				name: info.name,
				place: skillTierLabel(info.tier),
				tokens: skillListingTokens(info),
				state: skillStateOf(info),
				description: info.description,
				path: info.path,
				...(info.problem !== undefined && !isOffProblem(info.problem)
					? { problem: info.problem }
					: {}),
				...(use ? { use } : {}),
			}
		})
		.sort((a, b) => a.place.localeCompare(b.place) || a.name.localeCompare(b.name))
}

/** A section of the Installed tab: its heading, the rows under it, and a line for when there are none. */
export interface Section {
	readonly title: string
	readonly items: readonly ScreenItem[]
	readonly empty?: string
}

export function itemsOf(inputs: ScreenInputs): readonly ScreenItem[] {
	return [
		...mcpItems(inputs),
		...inputs.plugins
			.map(
				(plugin): PluginItem => ({
					kind: 'plugin',
					id: `plugin:${plugin.name}`,
					name: plugin.name,
					plugin,
				}),
			)
			.sort((a, b) => a.name.localeCompare(b.name)),
		...skillItems(inputs),
	]
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface PluginScreenState {
	readonly tab: PluginTab
	readonly inputs: ScreenInputs
	readonly query: string
	/** Typed characters go to the search box. */
	readonly searching: boolean
	/** The selected row's id on Installed; the first visible row when it is filtered out. */
	readonly selected: string | undefined
	/** The row whose detail view is open. */
	readonly detail: string | undefined
	/** The cursor over a detail view's actions. */
	readonly action: number
	/** A detail view's tool list is open. */
	readonly toolsOpen: boolean
	/** First line shown on Errors and Stats, which scroll instead of selecting. */
	readonly scroll: number
	/** One line the last key left, shown above the footer. */
	readonly notice?: string
	/** A change is being made: keys wait. */
	readonly busy?: string
}

export function openScreen(inputs: ScreenInputs, tab: PluginTab = 'installed'): PluginScreenState {
	const first = itemsOf(inputs)[0]
	return {
		tab,
		inputs,
		query: '',
		searching: false,
		selected: first?.id,
		detail: undefined,
		action: 0,
		toolsOpen: false,
		scroll: 0,
	}
}

/** The same screen over fresher inputs: tab, search and cursor kept where they still make sense. */
export function refreshScreen(state: PluginScreenState, inputs: ScreenInputs): PluginScreenState {
	const next = { ...state, inputs }
	const ids = new Set(itemsOf(inputs).map((item) => item.id))
	return {
		...next,
		detail: state.detail !== undefined && ids.has(state.detail) ? state.detail : undefined,
		selected: state.selected !== undefined && ids.has(state.selected) ? state.selected : undefined,
	}
}

function matches(item: ScreenItem, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (needle === '') return true
	const words =
		item.kind === 'skill'
			? [item.name, 'skill', item.place, item.description]
			: item.kind === 'plugin'
				? [item.name, 'plugin', item.plugin.scope, item.plugin.description]
				: [item.name, 'mcp', 'tool server', item.status]
	return words.some((text) => text.toLowerCase().includes(needle))
}

export function visibleItems(state: PluginScreenState): readonly ScreenItem[] {
	return itemsOf(state.inputs).filter((item) => matches(item, state.query))
}

/** The Installed tab's sections in order, with a section left out when the search empties it. */
export function sections(state: PluginScreenState): readonly Section[] {
	const shown = visibleItems(state)
	const of = (kind: ItemKind) => shown.filter((item) => item.kind === kind)
	const searching = state.query.trim() !== ''
	const result: Section[] = []
	const servers = of('mcp')
	if (servers.length > 0) result.push({ title: 'MCP servers', items: servers })
	const plugins = of('plugin')
	if (plugins.length > 0) result.push({ title: 'Plugins', items: plugins })
	else if (!searching) {
		result.push({
			title: 'Plugins',
			items: [],
			empty: state.inputs.pluginsNote ?? 'No plugins are loaded in this conversation.',
		})
	}
	const skills = of('skill')
	if (skills.length > 0) result.push({ title: 'Skills', items: skills })
	return result
}

export function selectedIndex(state: PluginScreenState): number {
	const index = visibleItems(state).findIndex((item) => item.id === state.selected)
	return index < 0 ? 0 : index
}

export function selectedItem(state: PluginScreenState): ScreenItem | undefined {
	return visibleItems(state)[selectedIndex(state)]
}

export function detailItem(state: PluginScreenState): ScreenItem | undefined {
	return state.detail === undefined
		? undefined
		: itemsOf(state.inputs).find((item) => item.id === state.detail)
}

// ---------------------------------------------------------------------------
// detail views
// ---------------------------------------------------------------------------

export type DetailAction = 'view-tools' | 'enable' | 'disable' | 'remember' | 'back'

export interface DetailActionRow {
	readonly id: DetailAction
	readonly label: string
	readonly disabled?: string
}

export function detailActions(item: ScreenItem, toolsOpen: boolean): readonly DetailActionRow[] {
	const back: DetailActionRow = { id: 'back', label: 'Back' }
	if (item.kind === 'mcp') {
		return item.tools.length > 0
			? [{ id: 'view-tools', label: toolsOpen ? 'Hide tools' : 'View tools' }, back]
			: [back]
	}
	if (item.kind === 'plugin') {
		const enabled = item.plugin.status === 'enabled'
		return [
			{
				id: enabled ? 'disable' : 'enable',
				label: enabled ? 'Disable for this conversation' : 'Enable for this conversation',
			},
			{
				id: 'remember',
				label: `Keep ${enabled ? 'enabled' : 'disabled'} after restart`,
				...(item.plugin.startupEnabled === enabled
					? { disabled: 'already the startup setting' }
					: {}),
			},
			back,
		]
	}
	return [back]
}

/** A detail view's text lines, unwrapped: `Label: value`, or a heading. */
export function detailLines(item: ScreenItem, toolsOpen: boolean, now: number): readonly string[] {
	if (item.kind === 'mcp') {
		const status =
			item.status === 'connected'
				? '✓ connected'
				: item.status === 'connecting'
					? 'connecting'
					: `failed${item.reason ? `: ${item.reason}` : ''}`
		return [
			item.name,
			'MCP server',
			'',
			`Status: ${status}`,
			...(item.where ? [`Command: ${item.where}`] : []),
			...(item.status === 'connected'
				? [`Capabilities: ${item.tools.length} tool${item.tools.length === 1 ? '' : 's'}`]
				: []),
			...(toolsOpen ? ['', ...item.tools.map((tool) => `  ${tool}`)] : []),
		]
	}
	if (item.kind === 'plugin') {
		return [item.name, 'Plugin', '', ...pluginDetailRows(item.plugin)]
	}
	return [
		item.name,
		'Skill',
		'',
		`State: ${stateWord(item.state)}`,
		`Place: ${item.place}`,
		`File: ${item.path}`,
		`Listing cost: ${formatTokenCost(item.tokens)}`,
		`Used: ${usageWords(item.use, now)}`,
		...(item.problem ? [`Problem: ${item.problem}`] : []),
		...(item.description ? ['', item.description] : []),
		'',
		'Change how it is offered with /skills.',
	]
}

function stateWord(state: SkillState): string {
	return state === 'on'
		? 'on'
		: state === 'off'
			? 'off'
			: state === 'name-only'
				? 'name-only (listed without its description)'
				: 'user-only (the model is not told about it; /name still runs it)'
}

// ---------------------------------------------------------------------------
// errors and stats
// ---------------------------------------------------------------------------

export interface ErrorEntry {
	readonly title: string
	readonly message: string
	readonly guidance: string
}

/** What failed to load, as one entry each, with what to do about it. */
export function errorEntries(inputs: ScreenInputs): readonly ErrorEntry[] {
	const entries: ErrorEntry[] = []
	for (const plugin of inputs.plugins) {
		if (plugin.startupError) {
			entries.push({
				title: `Plugin ${plugin.name}`,
				message: plugin.startupError,
				guidance: 'Fix the plugin folder, then restart. namzu plugin validate checks a manifest.',
			})
		} else if (plugin.startupEnabled === undefined) {
			entries.push({
				title: `Plugin ${plugin.name}`,
				message: 'Its remembered setting is not valid.',
				guidance: 'Open it here and choose Keep enabled or Keep disabled after restart.',
			})
		}
	}
	for (const server of inputs.mcp?.failed ?? []) {
		entries.push({
			title: `MCP server ${server.name}`,
			message: server.reason,
			guidance: 'Check its command or address in your configuration, then restart.',
		})
	}
	for (const skill of inputs.skills) {
		if (skill.problem !== undefined && !isOffProblem(skill.problem)) {
			entries.push({
				title: `Skill ${skill.name}`,
				message: skill.problem,
				guidance: `Fix the header of ${skill.path}.`,
			})
		}
	}
	return entries
}

export interface StatsRow {
	readonly name: string
	readonly place: string
	/** The one-line listing cost, `-` when the skill is not in the listing. */
	readonly context: string
	readonly sevenDay: string
	readonly uses: string
	readonly last: string
}

/** Tokens as the stats table writes them: `~240`, `< 20`, to the nearest ten. */
function figure(tokens: number): string {
	return tokens < 20 ? '< 20' : `~${Math.round(tokens / 10) * 10}`
}

/** The skills with their figures, the least used first (the ones to look at), then by name. */
export function statsRows(inputs: ScreenInputs): readonly StatsRow[] {
	const rows = skillItems(inputs)
		.filter((skill) => skill.problem === undefined)
		.map((skill) => {
			const seven = sevenDayTokens(skill.use, inputs.now)
			return {
				row: {
					name: skill.name,
					place: skill.place,
					context: skill.state === 'on' || skill.state === 'name-only' ? figure(skill.tokens) : '-',
					sevenDay: seven === undefined ? '-' : figure(seven),
					uses: String(skill.use?.count ?? 0),
					last: ageWord(skill.use, inputs.now),
				},
				count: skill.use?.count ?? 0,
			}
		})
	return rows
		.sort((a, b) => a.count - b.count || a.row.name.localeCompare(b.row.name))
		.map((entry) => entry.row)
}

/** How many skills are in the listing and have never been loaded. */
export function unusedInListing(inputs: ScreenInputs): number {
	return skillItems(inputs).filter(
		(skill) =>
			skill.problem === undefined &&
			(skill.state === 'on' || skill.state === 'name-only') &&
			(skill.use?.count ?? 0) === 0,
	).length
}

/** The explanation lines under the Stats table. */
export function statsNotes(inputs: ScreenInputs): readonly string[] {
	const since = new Date(inputs.usage.since).toISOString().slice(0, 10)
	return [
		"context = this skill's one-line listing in the system prompt, included every turn",
		'(dash = not in the listing, costs nothing; the full SKILL.md loads only when it runs)',
		'7d tokens = the size of what loading the skill added to a conversation in the last 7 days, on this machine',
		`uses, last used and 7d tokens count from ${since}, when recording began; earlier runs are not in them`,
	]
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

export interface ScreenKey {
	readonly input: string
	readonly up?: boolean
	readonly down?: boolean
	readonly left?: boolean
	readonly right?: boolean
	readonly pageUp?: boolean
	readonly pageDown?: boolean
	readonly home?: boolean
	readonly end?: boolean
	readonly escape?: boolean
	readonly return?: boolean
	readonly backspace?: boolean
	readonly delete?: boolean
	readonly ctrl?: boolean
	readonly meta?: boolean
}

/** What a key asks the session for. App carries it out and then calls `refreshScreen`. */
export type ScreenEffect =
	| { readonly kind: 'plugin-enable'; readonly name: string; readonly enabled: boolean }
	| { readonly kind: 'plugin-remember'; readonly name: string }

export interface ScreenStep {
	readonly state: PluginScreenState
	readonly close: boolean
	readonly effect?: ScreenEffect
}

const PAGE = 8

function tabAt(tab: PluginTab, by: number): PluginTab {
	const index = PLUGIN_TABS.findIndex((item) => item.id === tab)
	const next = (index + by + PLUGIN_TABS.length) % PLUGIN_TABS.length
	return PLUGIN_TABS[next]?.id ?? tab
}

function select(state: PluginScreenState, index: number): PluginScreenState {
	const visible = visibleItems(state)
	const item = visible[Math.max(0, Math.min(index, visible.length - 1))]
	return { ...state, selected: item?.id, notice: undefined }
}

/** The line a Space on a row that cannot be switched here explains. */
function cannotSwitch(item: ScreenItem): string {
	return item.kind === 'skill'
		? 'Change how a skill is offered with /skills.'
		: 'Tool servers are set in your configuration; see /mcp.'
}

/** One key on the screen. `maxScroll` is how far Errors or Stats can scroll; the component knows its height. */
export function step(state: PluginScreenState, key: ScreenKey, maxScroll = 0): ScreenStep {
	const stay = (next: PluginScreenState): ScreenStep => ({ state: next, close: false })
	if (state.busy !== undefined) return stay(state)

	if (key.left || key.right) {
		if (state.searching) return stay(state)
		return stay({
			...state,
			tab: tabAt(state.tab, key.right ? 1 : -1),
			detail: undefined,
			action: 0,
			toolsOpen: false,
			scroll: 0,
			notice: undefined,
		})
	}

	// A detail view.
	const open = detailItem(state)
	if (open) {
		const actions = detailActions(open, state.toolsOpen)
		const at = Math.min(state.action, actions.length - 1)
		if (key.escape) {
			return stay({ ...state, detail: undefined, action: 0, toolsOpen: false, notice: undefined })
		}
		if (key.up) return stay({ ...state, action: Math.max(0, at - 1), notice: undefined })
		if (key.down)
			return stay({ ...state, action: Math.min(actions.length - 1, at + 1), notice: undefined })
		if (key.return || (key.input === ' ' && !key.ctrl && !key.meta)) {
			const chosen = actions[at]
			if (!chosen) return stay(state)
			if (chosen.disabled !== undefined)
				return stay({ ...state, notice: `Not now: ${chosen.disabled}.` })
			switch (chosen.id) {
				case 'back':
					return stay({
						...state,
						detail: undefined,
						action: 0,
						toolsOpen: false,
						notice: undefined,
					})
				case 'view-tools':
					return stay({ ...state, toolsOpen: !state.toolsOpen, notice: undefined })
				case 'enable':
				case 'disable':
					return open.kind === 'plugin'
						? {
								state: { ...state, notice: undefined },
								close: false,
								effect: { kind: 'plugin-enable', name: open.name, enabled: chosen.id === 'enable' },
							}
						: stay(state)
				case 'remember':
					return open.kind === 'plugin'
						? {
								state: { ...state, notice: undefined },
								close: false,
								effect: { kind: 'plugin-remember', name: open.name },
							}
						: stay(state)
			}
		}
		return stay(state)
	}

	// Errors and Stats scroll.
	if (state.tab !== 'installed') {
		if (key.escape) return { state, close: true }
		const move = (by: number) =>
			stay({ ...state, scroll: Math.max(0, Math.min(maxScroll, state.scroll + by)) })
		if (key.up) return move(-1)
		if (key.down) return move(1)
		if (key.pageUp) return move(-PAGE)
		if (key.pageDown) return move(PAGE)
		if (key.home) return stay({ ...state, scroll: 0 })
		if (key.end) return stay({ ...state, scroll: maxScroll })
		return stay(state)
	}

	// Installed.
	const visible = visibleItems(state)
	const at = selectedIndex(state)
	if (key.up) return stay(select(state, at - 1))
	if (key.down) return stay(select(state, at + 1))
	if (key.pageUp) return stay(select(state, at - PAGE))
	if (key.pageDown) return stay(select(state, at + PAGE))
	if (key.home) return stay(select(state, 0))
	if (key.end) return stay(select(state, visible.length - 1))
	if (state.searching) {
		if (key.escape) return stay(select({ ...state, searching: false, query: '' }, 0))
		if (key.return) return stay({ ...state, searching: false })
		if (key.backspace || key.delete) {
			return stay(select({ ...state, query: [...state.query].slice(0, -1).join('') }, 0))
		}
		if (key.ctrl || key.meta || key.input === '') return stay(state)
		const text = key.input.replace(/\p{Cc}/gu, '')
		return text === '' ? stay(state) : stay(select({ ...state, query: state.query + text }, 0))
	}
	if (key.escape) return { state, close: true }
	const item = visible[at]
	if (key.return) {
		return item
			? stay({ ...state, detail: item.id, action: 0, toolsOpen: false, notice: undefined })
			: stay(state)
	}
	if (key.input === ' ' && !key.ctrl && !key.meta) {
		if (!item) return stay(state)
		if (item.kind === 'plugin') {
			const enabled = item.plugin.status === 'enabled'
			return {
				state: { ...state, notice: undefined },
				close: false,
				effect: { kind: 'plugin-enable', name: item.name, enabled: !enabled },
			}
		}
		return stay({ ...state, notice: cannotSwitch(item) })
	}
	if (key.ctrl || key.meta) return stay(state)
	if (key.input === '/') return stay({ ...state, searching: true, notice: undefined })
	return stay(state)
}

/** Marks a row while a change to it is waiting, and what to say. */
export function waiting(state: PluginScreenState, message: string | undefined): PluginScreenState {
	return { ...state, busy: message, notice: message }
}

/** The screen after a change failed or finished: the notice says which. */
export function withNotice(
	state: PluginScreenState,
	notice: string | undefined,
): PluginScreenState {
	return { ...state, busy: undefined, notice }
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/** Cells before a name: cursor, space, mark, space. */
const LEAD_WIDTH = 4
const GAP = 2
const MIN_NAME = 8
const KIND_WIDTH = 6

/** The mark before a row: a tick when it is on, a ring when it is off, `!` when it failed, `·` while it connects. */
export function markOf(item: ScreenItem): string {
	if (item.kind === 'mcp') {
		return item.status === 'connected' ? '✓' : item.status === 'failed' ? '!' : '·'
	}
	if (item.kind === 'plugin') return item.plugin.status === 'enabled' ? '✓' : '◯'
	if (item.problem !== undefined || item.state === 'off') return '◯'
	return '✓'
}

/** The words after the kind: place, cost and use for a skill; scope and counts for a plugin; status for a server. */
export function metaParts(item: ScreenItem, now: number): readonly string[] {
	if (item.kind === 'mcp') {
		return [
			item.status,
			...(item.status === 'connected'
				? [`${item.tools.length} tool${item.tools.length === 1 ? '' : 's'}`]
				: []),
		]
	}
	if (item.kind === 'plugin') {
		const plugin = item.plugin
		return [
			plugin.scope,
			...(plugin.status === 'enabled' ? [] : [plugin.status]),
			`${plugin.skills.length} skill${plugin.skills.length === 1 ? '' : 's'}`,
			...(plugin.startupError ? ['error'] : []),
		]
	}
	const state = item.state === 'name-only' || item.state === 'user-only' ? item.state : undefined
	return [
		...(item.problem !== undefined ? ['locked'] : state ? [state] : []),
		item.place,
		`${figure(item.tokens)} tok`,
		usageWords(item.use, now),
	]
}

export interface ItemLayout {
	readonly lead: string
	/** The name, padded to the name column. */
	readonly name: string
	/** The kind word, padded. */
	readonly kind: string
	readonly meta: string
}

function pad(text: string, columns: number): string {
	return text + ' '.repeat(Math.max(0, columns - choiceDisplayWidth(text)))
}

/** The widest name column the rows ask for, leaving the meta its place. */
export function nameColumn(items: readonly ScreenItem[], width: number): number {
	const widest = Math.max(0, ...items.map((item) => choiceDisplayWidth(item.name)))
	const room = Math.max(MIN_NAME, width - LEAD_WIDTH - GAP - KIND_WIDTH - GAP - 22)
	return Math.max(1, Math.min(widest, room))
}

/**
 * One row in `width` cells. When the meta does not fit it loses whole trailing
 * parts; when even the first part does not fit, the name gives up cells down
 * to a floor before the meta is cut mid-word. Never wider than `width`.
 */
export function layoutItem(
	item: ScreenItem,
	selected: boolean,
	nameWidth: number,
	width: number,
	now: number,
): ItemLayout {
	const lead = `${selected ? '❯' : ' '} ${markOf(item)} `
	const body = Math.max(1, width - LEAD_WIDTH)
	const parts = metaParts(item, now)
	const full = parts.join(' · ')
	const kindCells = body >= 40 ? KIND_WIDTH : 0
	const kind = kindCells > 0 ? pad(KIND_WORD[item.kind], kindCells) : ''
	let nameCells = Math.min(nameWidth, Math.max(1, body - kindCells))
	const rest = (cells: number) => body - cells - GAP - (kindCells > 0 ? kindCells + GAP : 0)
	if (rest(nameCells) < choiceDisplayWidth(full)) {
		const first = choiceDisplayWidth(parts[0] ?? '')
		nameCells = Math.max(Math.min(nameCells, MIN_NAME), Math.min(nameCells, rest(0) - first))
	}
	const name = truncateChoiceText(item.name, nameCells)
	const room = rest(nameCells)
	const meta = room >= 1 ? truncateAtSeparator(full, room) : ''
	return {
		lead,
		name: pad(name, nameCells) + (meta === '' && kind === '' ? '' : ' '.repeat(GAP)),
		kind: kind === '' ? '' : meta === '' ? kind.trimEnd() : kind + ' '.repeat(GAP),
		meta,
	}
}

/** One line of the Installed list: a heading, a row, a note under an empty heading, or a gap. */
export type ListLine =
	| { readonly kind: 'heading'; readonly text: string }
	| { readonly kind: 'item'; readonly item: ScreenItem }
	| { readonly kind: 'note'; readonly text: string }
	| { readonly kind: 'gap' }

/** The Installed tab flattened to lines, with a gap before each heading but the first. */
export function listLines(state: PluginScreenState): readonly ListLine[] {
	const lines: ListLine[] = []
	for (const section of sections(state)) {
		if (lines.length > 0) lines.push({ kind: 'gap' })
		lines.push({ kind: 'heading', text: section.title })
		for (const item of section.items) lines.push({ kind: 'item', item })
		if (section.items.length === 0 && section.empty)
			lines.push({ kind: 'note', text: section.empty })
	}
	return lines
}

/** How many list lines fit in `terminalRows`, with the tab row, search box, footnote and footer counted. */
export function lineBudget(terminalRows: number): number {
	return Math.max(4, terminalRows - 11)
}

/** The tab row: `Plugins  Installed  Errors  Stats` with the active tab marked by the component. */
export const TITLE = 'Plugins'

/** A detail view's lines, wrapped to `width`; a continuation line is indented under its label. */
export function wrappedDetail(lines: readonly string[], width: number): readonly string[] {
	const out: string[] = []
	for (const line of lines) {
		const room = Math.max(10, width)
		let wrapped = wrapChoiceText(line, room)
		// A continuation is indented two columns, so a line that needs one is wrapped two columns
		// narrower: otherwise a broken path comes out wider than the screen and loses its end.
		if (wrapped.length > 1) wrapped = wrapChoiceText(line, room - 2)
		for (const [index, part] of wrapped.entries()) out.push(index === 0 ? part : `  ${part}`)
	}
	return out
}

// ---------------------------------------------------------------------------
// the table on Stats
// ---------------------------------------------------------------------------

export interface StatsColumn {
	readonly id: 'name' | 'place' | 'context' | 'sevenDay' | 'uses' | 'last'
	readonly title: string
	readonly width: number
	readonly right: boolean
}

/** The columns that fit `width`: Source goes first, then 7d tokens, and the name takes what is left. */
export function statsColumns(rows: readonly StatsRow[], width: number): readonly StatsColumn[] {
	const widest = (pick: (row: StatsRow) => string, title: string) =>
		Math.max(choiceDisplayWidth(title), ...rows.map((row) => choiceDisplayWidth(pick(row))))
	const fixed: StatsColumn[] = [
		{
			id: 'place',
			title: 'Source',
			width: Math.min(
				14,
				widest((r) => r.place, 'Source'),
			),
			right: false,
		},
		{ id: 'context', title: 'Context', width: widest((r) => r.context, 'Context'), right: true },
		{
			id: 'sevenDay',
			title: '7d tokens',
			width: widest((r) => r.sevenDay, '7d tokens'),
			right: true,
		},
		{ id: 'uses', title: 'Uses', width: widest((r) => r.uses, 'Uses'), right: true },
		{ id: 'last', title: 'Last used', width: widest((r) => r.last, 'Last used'), right: false },
	]
	const nameNeeds = Math.min(24, Math.max(8, ...rows.map((row) => choiceDisplayWidth(row.name))))
	let kept = fixed
	const total = (columns: readonly StatsColumn[]) =>
		columns.reduce((sum, column) => sum + column.width + GAP, 0)
	for (const drop of ['place', 'sevenDay'] as const) {
		if (total(kept) + nameNeeds > width) kept = kept.filter((column) => column.id !== drop)
	}
	const nameWidth = Math.max(4, Math.min(width - total(kept), Math.max(nameNeeds, 8)))
	const name: StatsColumn = {
		id: 'name',
		title: 'Skill',
		width: Math.max(4, nameWidth),
		right: false,
	}
	return [name, ...kept]
}

/** One table line in `width` cells: the header when `row` is undefined. */
export function statsLine(columns: readonly StatsColumn[], row: StatsRow | undefined): string {
	return columns
		.map((column) => {
			const text = row === undefined ? column.title : row[column.id === 'name' ? 'name' : column.id]
			const fitted = truncateChoiceText(text, column.width)
			const gap = Math.max(0, column.width - choiceDisplayWidth(fitted))
			return column.right ? ' '.repeat(gap) + fitted : fitted + ' '.repeat(gap)
		})
		.join(' '.repeat(GAP))
		.trimEnd()
}

// ---------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------

export function screenHints(state: PluginScreenState): readonly {
	readonly text: string
	readonly short: string
	readonly rank: number
}[] {
	if (state.searching) {
		return [
			{ text: 'Type to search', short: 'Type', rank: 3 },
			{ text: '↑/↓ to navigate', short: '↑/↓', rank: 4 },
			{ text: 'Enter to keep', short: 'Enter', rank: 4 },
			{ text: 'Esc to clear', short: 'Esc', rank: 5 },
		]
	}
	if (detailItem(state)) {
		return [
			{ text: '↑/↓ to navigate', short: '↑/↓', rank: 4 },
			{ text: '←/→ to switch', short: '←/→', rank: 3 },
			{ text: 'Enter to select', short: 'Enter', rank: 5 },
			{ text: 'Esc to go back', short: 'Esc', rank: 5 },
		]
	}
	if (state.tab === 'installed') {
		return [
			{ text: '↑/↓ to navigate', short: '↑/↓', rank: 5 },
			{ text: '←/→ to switch', short: '←/→', rank: 4 },
			{ text: 'Space to toggle', short: 'Space', rank: 3 },
			{ text: '/ to search', short: '/ search', rank: 2 },
			{ text: 'Enter to select', short: 'Enter', rank: 4 },
			{ text: 'Esc to close', short: 'Esc', rank: 5 },
		]
	}
	return [
		{ text: '↑/↓ to scroll', short: '↑/↓', rank: 3 },
		{ text: '←/→ to switch', short: '←/→', rank: 5 },
		{ text: 'Esc to close', short: 'Esc', rank: 5 },
	]
}
