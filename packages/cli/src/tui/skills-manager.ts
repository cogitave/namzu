/**
 * The `/skills` screen as data: the rows, the cursor, the search and the sort,
 * one pure step per key, and how a row is laid out in a given width.
 *
 * The component (`SkillsManager.tsx`) only draws what this returns, and App
 * only forwards keys and saves when the screen closes, so everything a key does
 * is testable without a terminal. Nothing here touches a file: `pendingChanges`
 * says what the screen would write, and the host writes it.
 */

import {
	type SkillState,
	baseSkillState,
	formatTokenCost,
	nextSkillState,
	skillListingTokens,
	skillStateOf,
} from '../skills/overrides.js'
import { type SkillInfo, isOffProblem, skillTierLabel } from '../skills/store.js'
import {
	choiceDisplayWidth,
	truncateAtSeparator,
	truncateChoiceText,
} from './terminal-choice-text.js'

export interface ManagerRow {
	readonly name: string
	readonly description: string
	/** What the screen shows now. */
	readonly state: SkillState
	/** What the roster said when the screen opened. */
	readonly initial: SkillState
	/** What the layers under the project's local file give: a saved change that lands here removes its key. */
	readonly base: SkillState
	/** Where the skill lives, as the listings word it (`user`, `project`, `built-in`). */
	readonly place: string
	readonly tokens: number
	/** Why the row cannot be changed (a file that does not parse), when it cannot. */
	readonly locked?: string
	/** What is worth saying about the row when it is selected. */
	readonly note?: string
}

export type ManagerSort = 'default' | 'tokens'

export interface ManagerState {
	readonly rows: readonly ManagerRow[]
	/** The selected skill's name; the first visible row when it is filtered out. */
	readonly selected: string | undefined
	readonly query: string
	/** Typed characters go to the search box. */
	readonly searching: boolean
	readonly sort: ManagerSort
}

/** The mark before a name: a tick for a skill the model can still be told about or the operator can run, a ring for off. */
export const MARK_ON = '✓'
export const MARK_OFF = '◯'

/** The rows for a roster, in the default order: where it lives, then name. */
export function openManager(
	skills: readonly SkillInfo[],
	disabled: readonly string[] | undefined,
): ManagerState {
	const rows = skills
		.map((info): ManagerRow => {
			const state = skillStateOf(info)
			const locked =
				info.problem !== undefined && !isOffProblem(info.problem) ? info.problem : undefined
			const hides = info.shadows?.length ?? 0
			const note =
				locked ??
				(hides > 0
					? `Hides ${hides} skill${hides === 1 ? '' : 's'} of the same name in a lower folder.`
					: info.invocation === 'operator' && info.state === undefined
						? 'Its author made it run only from /name.'
						: info.userInvocable === false
							? 'Its author made it for the model only; it has no /name.'
							: undefined)
			return {
				name: info.name,
				description: info.description,
				state,
				initial: state,
				base: baseSkillState(info.name, disabled),
				place: skillTierLabel(info.tier),
				tokens: skillListingTokens(info),
				...(locked !== undefined ? { locked } : {}),
				...(note !== undefined ? { note } : {}),
			}
		})
		.sort((a, b) => a.place.localeCompare(b.place) || a.name.localeCompare(b.name))
	return { rows, selected: rows[0]?.name, query: '', searching: false, sort: 'default' }
}

/** Whether `row` matches the search: name, description or place, any case. */
function matches(row: ManagerRow, query: string): boolean {
	const needle = query.trim().toLowerCase()
	if (needle === '') return true
	return [row.name, row.description, row.place].some((text) => text.toLowerCase().includes(needle))
}

/** The rows on screen: filtered, then in the chosen order (largest first by tokens, ties as before). */
export function visibleRows(state: ManagerState): readonly ManagerRow[] {
	const shown = state.rows.filter((row) => matches(row, state.query))
	return state.sort === 'tokens' ? [...shown].sort((a, b) => b.tokens - a.tokens) : shown
}

/** Index of the selected row among the visible ones; 0 when it is filtered out. */
export function selectedIndex(state: ManagerState): number {
	const index = visibleRows(state).findIndex((row) => row.name === state.selected)
	return index < 0 ? 0 : index
}

/** `16 skills`, `3 of 16 skills`, with ` · sorted by tokens` after `t`. */
export function subtitle(state: ManagerState): string {
	const total = state.rows.length
	const shown = visibleRows(state).length
	const count = `${shown === total ? total : `${shown} of ${total}`} skill${total === 1 ? '' : 's'}`
	return state.sort === 'tokens' ? `${count} · sorted by tokens` : count
}

/** What the key line of `SkillsManager` receives from App. */
export interface ManagerKey {
	readonly input: string
	readonly up?: boolean
	readonly down?: boolean
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

export interface ManagerStep {
	readonly state: ManagerState
	/** Esc on the list: the host saves and closes. */
	readonly close: boolean
}

function select(state: ManagerState, index: number): ManagerState {
	const visible = visibleRows(state)
	const row = visible[Math.max(0, Math.min(index, visible.length - 1))]
	return { ...state, selected: row?.name }
}

function cycle(state: ManagerState): ManagerState {
	const index = selectedIndex(state)
	const row = visibleRows(state)[index]
	if (!row || row.locked !== undefined) return state
	const state2 = nextSkillState(row.state)
	return {
		...state,
		rows: state.rows.map((item) => (item.name === row.name ? { ...item, state: state2 } : item)),
	}
}

/** The rows a page key moves over. */
const PAGE = 8

/** One key on the screen. */
export function manage(state: ManagerState, key: ManagerKey): ManagerStep {
	const stay = (next: ManagerState): ManagerStep => ({ state: next, close: false })
	const visible = visibleRows(state)
	const at = selectedIndex(state)
	if (key.up) return stay(select(state, at - 1))
	if (key.down) return stay(select(state, at + 1))
	if (key.pageUp) return stay(select(state, at - PAGE))
	if (key.pageDown) return stay(select(state, at + PAGE))
	if (key.home) return stay(select(state, 0))
	if (key.end) return stay(select(state, visible.length - 1))
	if (state.searching) {
		if (key.escape) {
			// The first Esc leaves the box (and clears what was typed); it closes nothing.
			return stay(select({ ...state, searching: false, query: '' }, 0))
		}
		if (key.return) return stay({ ...state, searching: false })
		if (key.backspace || key.delete) {
			const query = [...state.query].slice(0, -1).join('')
			return stay(select({ ...state, query }, 0))
		}
		if (key.ctrl || key.meta || key.input === '') return stay(state)
		const text = key.input.replace(/\p{Cc}/gu, '')
		if (text === '') return stay(state)
		return stay(select({ ...state, query: state.query + text }, 0))
	}
	if (key.escape) return { state, close: true }
	if (key.return || (key.input === ' ' && !key.ctrl && !key.meta)) return stay(cycle(state))
	if (key.ctrl || key.meta) return stay(state)
	if (key.input === '/') return stay({ ...state, searching: true })
	if (key.input === 't')
		return stay({ ...state, sort: state.sort === 'tokens' ? 'default' : 'tokens' })
	return stay(state)
}

/**
 * What the screen would save, keyed by skill name: the state to write, or `null`
 * to take the key out because the new state is what the layers below already
 * give. A row left where it started is not in the answer, so a full round of
 * Space changes nothing.
 */
export function pendingChanges(state: ManagerState): Record<string, SkillState | null> {
	const changes: Record<string, SkillState | null> = {}
	for (const row of state.rows) {
		if (row.state === row.initial) continue
		changes[row.name] = row.state === row.base ? null : row.state
	}
	return changes
}

/** The transcript row the screen leaves when it closes. */
export function closingLine(
	changed: number,
	failure: string | undefined,
): { readonly text: string; readonly failed: boolean } {
	if (failure !== undefined)
		return { text: `Couldn't save skill settings: ${failure}`, failed: true }
	if (changed === 0) return { text: 'No changes', failed: false }
	return {
		text: `Updated ${changed} skill${changed === 1 ? '' : 's'} in this project`,
		failed: false,
	}
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

export interface RowLayout {
	/** `❯ ✓ ` or `  ◯ `: cursor and mark. */
	readonly lead: string
	/** The name, padded to the name column. */
	readonly name: string
	readonly meta: string
}

/** Cells before the name: cursor, space, mark, space. */
const LEAD_WIDTH = 4
/** Cells between the name column and the meta. */
const GAP = 2
/** The least a name keeps before the meta starts giving way. */
const MIN_NAME = 8

/** The words after a name: `[state · ]place · cost`, or `locked · place` for a row that cannot change. */
export function metaParts(row: ManagerRow): readonly string[] {
	const word =
		row.locked !== undefined
			? 'locked'
			: row.state === 'name-only' || row.state === 'user-only'
				? row.state
				: undefined
	return [...(word ? [word] : []), row.place, formatTokenCost(row.tokens)]
}

/** The widest name column the visible rows ask for. */
export function nameColumn(rows: readonly ManagerRow[], width: number): number {
	const widest = Math.max(0, ...rows.map((row) => choiceDisplayWidth(row.name)))
	// A name keeps at most the share that leaves the meta its place, and never
	// less than it needs to be told apart.
	const room = Math.max(MIN_NAME, width - LEAD_WIDTH - GAP - 24)
	return Math.max(1, Math.min(widest, room))
}

function pad(text: string, columns: number): string {
	return text + ' '.repeat(Math.max(0, columns - choiceDisplayWidth(text)))
}

/**
 * One row in `width` cells. The name column is fixed by the caller; when the
 * meta does not fit it loses whole trailing parts (cost first), and when even
 * the place does not fit, the name gives up cells down to a floor before the
 * meta is cut mid-word. The result is never wider than `width`.
 */
export function layoutRow(
	row: ManagerRow,
	selected: boolean,
	nameWidth: number,
	width: number,
): RowLayout {
	const lead = `${selected ? '❯' : ' '} ${row.state === 'off' || row.locked !== undefined ? MARK_OFF : MARK_ON} `
	const body = Math.max(1, width - LEAD_WIDTH)
	const full = metaParts(row).join(' · ')
	let nameCells = Math.min(nameWidth, body)
	if (nameCells + GAP + choiceDisplayWidth(full) > body) {
		// Tighten the name before cutting the meta, down to the floor.
		const placeOnly = metaParts(row).slice(0, -1).join(' · ')
		const need = choiceDisplayWidth(placeOnly)
		nameCells = Math.max(Math.min(nameCells, MIN_NAME), Math.min(nameCells, body - GAP - need))
	}
	const name = truncateChoiceText(row.name, nameCells)
	const room = body - nameCells - GAP
	const meta = room >= 1 ? truncateAtSeparator(metaParts(row).join(' · '), room) : ''
	return { lead, name: pad(name, nameCells) + (meta === '' ? '' : ' '.repeat(GAP)), meta }
}

/** How many rows fit in `terminalRows` once the title, search box, footnote and footer are counted. */
export function rowBudget(terminalRows: number): number {
	return Math.max(3, terminalRows - 12)
}

/** The footer's hints, in the words the screen uses. */
export const MANAGER_HINTS = [
	{ text: '↑/↓ to navigate', short: '↑/↓', rank: 5 },
	{ text: 'Space to change', short: 'Space change', rank: 5 },
	{ text: '/ to search', short: '/ search', rank: 3 },
	{ text: 't to sort', short: 't sort', rank: 2 },
	{ text: 'Esc to close', short: 'Esc', rank: 5 },
] as const

/** The footer while the search box has the keys. */
export const MANAGER_SEARCH_HINTS = [
	{ text: 'Type to search', short: 'Type', rank: 3 },
	{ text: '↑/↓ to navigate', short: '↑/↓', rank: 4 },
	{ text: 'Enter to keep', short: 'Enter', rank: 4 },
	{ text: 'Esc to clear', short: 'Esc', rank: 5 },
] as const
