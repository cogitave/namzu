import { describe, expect, it } from 'vitest'
import {
	MAX_FILE_TABS,
	MIN_PANEL_WIDTH,
	activatePanelTab,
	activeFilePath,
	activityTab,
	browsePanelTabs,
	changesTab,
	clampPanelWidth,
	closePanelTab,
	emptyPanelTabs,
	ensurePanelTab,
	filePaths,
	fileTab,
	openFileTab,
	parsePanelTabs,
	readPanelTabs,
	readPanelWidth,
	serializePanelTabs,
	shownTab,
	writePanelTabs,
	writePanelWidth,
} from './file-tabs.js'

const none = { tabs: [], browsing: false }
const kinds = (state: { tabs: { kind: string }[] }) => state.tabs.map((tab) => tab.kind)

describe('panel tabs', () => {
	it('starts with Changes and Activity, showing Activity', () => {
		expect(emptyPanelTabs.tabs).toEqual([changesTab, activityTab])
		expect(emptyPanelTabs.active).toEqual(activityTab)
	})
	it('opens a file once and activates it, carrying the line', () => {
		const a = openFileTab(emptyPanelTabs, 'docs/a.md', 12)
		expect(filePaths(a)).toEqual(['docs/a.md'])
		expect(a).toMatchObject({ active: fileTab('docs/a.md'), line: 12, browsing: false })
		expect(kinds(a)).toEqual(['changes', 'activity', 'file'])
		const again = openFileTab(a, 'docs/a.md')
		expect(filePaths(again)).toEqual(['docs/a.md'])
		expect(again.line).toBeUndefined()
	})
	it('ensures Changes first and Activity after it, without duplicating', () => {
		let state = ensurePanelTab(openFileTab(none, 'a'), activityTab)
		expect(kinds(state)).toEqual(['activity', 'file'])
		state = ensurePanelTab(state, changesTab)
		expect(kinds(state)).toEqual(['changes', 'activity', 'file'])
		expect(state.active).toEqual(changesTab)
		const again = ensurePanelTab(state, changesTab)
		expect(kinds(again)).toEqual(['changes', 'activity', 'file'])
		const middle = ensurePanelTab(ensurePanelTab(openFileTab(none, 'a'), changesTab), activityTab)
		expect(kinds(middle)).toEqual(['changes', 'activity', 'file'])
	})
	it('activates only a tab that is open, and leaves browsing', () => {
		const browsing = browsePanelTabs(emptyPanelTabs)
		expect(browsing.browsing).toBe(true)
		expect(activatePanelTab(browsing, changesTab)).toMatchObject({
			active: changesTab,
			browsing: false,
		})
		expect(activatePanelTab(emptyPanelTabs, fileTab('x'))).toBe(emptyPanelTabs)
	})
	it('closes the active tab onto its right neighbour, then its left', () => {
		let state = emptyPanelTabs
		for (const path of ['a', 'b']) state = openFileTab(state, path)
		state = activatePanelTab(state, activityTab)
		state = closePanelTab(state, activityTab)
		expect(state.active).toEqual(fileTab('a'))
		state = closePanelTab(state, fileTab('a'))
		expect(state.active).toEqual(fileTab('b'))
		state = closePanelTab(state, fileTab('b'))
		expect(state.active).toEqual(changesTab)
		state = closePanelTab(state, changesTab)
		expect(state).toMatchObject({ tabs: [], active: undefined })
	})
	it('keeps the quick open showing when the hidden active tab closes', () => {
		const state = closePanelTab(browsePanelTabs(emptyPanelTabs), activityTab)
		expect(state.browsing).toBe(true)
		expect(state.active).toEqual(changesTab)
	})
	it('keeps the active tab when another closes', () => {
		const state = closePanelTab(openFileTab(emptyPanelTabs, 'a'), changesTab)
		expect(state.active).toEqual(fileTab('a'))
		expect(kinds(state)).toEqual(['activity', 'file'])
	})
	it('shows the first remaining tab when the active one is not allowed', () => {
		const state = openFileTab(emptyPanelTabs, 'a')
		expect(shownTab(state, (tab) => tab.kind !== 'file')).toEqual(changesTab)
		expect(shownTab(none, () => true)).toBeUndefined()
	})
	it('drops the oldest other file tab past the cap, never a fixed tab', () => {
		let state = emptyPanelTabs
		for (let index = 0; index <= MAX_FILE_TABS; index++) state = openFileTab(state, `f${index}`)
		expect(filePaths(state)).toHaveLength(MAX_FILE_TABS)
		expect(filePaths(state)).not.toContain('f0')
		expect(activeFilePath(state)).toBe(`f${MAX_FILE_TABS}`)
		expect(state.tabs.slice(0, 2)).toEqual([changesTab, activityTab])
	})
	it('round-trips through storage, including an empty list', () => {
		const state = openFileTab(openFileTab(emptyPanelTabs, 'a'), 'b')
		expect(parsePanelTabs(serializePanelTabs(state))).toEqual({
			tabs: state.tabs,
			active: fileTab('b'),
			browsing: false,
		})
		expect(parsePanelTabs(serializePanelTabs(none))).toEqual({
			tabs: [],
			active: undefined,
			browsing: false,
		})
	})
	it('rejects damaged records and falls back to the defaults', () => {
		expect(
			parsePanelTabs(
				'{"v":2,"tabs":[{"kind":"file","path":"a"},{"kind":"file","path":"a"},{"kind":"x"},1],"active":{"kind":"file","path":"zz"}}',
			),
		).toEqual({ tabs: [fileTab('a')], active: undefined, browsing: false })
		expect(parsePanelTabs('nope')).toEqual(emptyPanelTabs)
		expect(parsePanelTabs('x'.repeat(9000))).toEqual(emptyPanelTabs)
		expect(parsePanelTabs(null)).toEqual(emptyPanelTabs)
	})
	it('migrates the old file-only record, giving it Changes and Activity', () => {
		const old = '{"paths":[1,"a","a","b"],"active":"b"}'
		expect(parsePanelTabs(old)).toEqual({
			tabs: [changesTab, activityTab, fileTab('a'), fileTab('b')],
			active: fileTab('b'),
			browsing: false,
		})
		// With no active file, the tab the panel used to show stays the one shown.
		const idle = '{"paths":["a"]}'
		expect(parsePanelTabs(idle, 'changes').active).toEqual(changesTab)
		expect(parsePanelTabs(idle).active).toEqual(activityTab)
		expect(parsePanelTabs(null, 'changes').active).toEqual(changesTab)
	})
	it('survives storage that throws', () => {
		const broken = {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
			removeItem: () => {
				throw new Error('blocked')
			},
		}
		expect(readPanelTabs(broken, 's')).toEqual(emptyPanelTabs)
		expect(() => writePanelTabs(broken, 's', openFileTab(emptyPanelTabs, 'a'))).not.toThrow()
		expect(readPanelWidth(broken, 'p')).toBeUndefined()
		expect(() => writePanelWidth(broken, 'p', 400)).not.toThrow()
	})
	it('remembers the list per conversation', () => {
		const store = new Map<string, string>()
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		}
		writePanelTabs(storage, 'one', closePanelTab(emptyPanelTabs, changesTab))
		expect(kinds(readPanelTabs(storage, 'one'))).toEqual(['activity'])
		expect(kinds(readPanelTabs(storage, 'two'))).toEqual(['changes', 'activity'])
	})
})

describe('panel width', () => {
	it('stays between 320px and 70% of the pane', () => {
		expect(clampPanelWidth(100, 1000)).toBe(MIN_PANEL_WIDTH)
		expect(clampPanelWidth(900, 1000)).toBe(700)
		expect(clampPanelWidth(500, 1000)).toBe(500)
		expect(clampPanelWidth(500, 400)).toBe(MIN_PANEL_WIDTH)
		expect(clampPanelWidth(Number.NaN, 1000)).toBe(MIN_PANEL_WIDTH)
	})
	it('remembers a width per pane', () => {
		const store = new Map<string, string>()
		const storage = {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
		}
		writePanelWidth(storage, 'left', 512.4)
		expect(readPanelWidth(storage, 'left')).toBe(512)
		expect(readPanelWidth(storage, 'right')).toBeUndefined()
		store.set('namzu.workspace.panel-width:left', '12')
		expect(readPanelWidth(storage, 'left')).toBeUndefined()
	})
})
