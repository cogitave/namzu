import { describe, expect, it } from 'vitest'
import {
	MAX_FILE_TABS,
	MIN_PANEL_WIDTH,
	activateFileTab,
	browseFileTabs,
	clampPanelWidth,
	closeFileTab,
	emptyFileTabs,
	leaveFileTabs,
	openFileTab,
	parseFileTabs,
	readFileTabs,
	readPanelWidth,
	serializeFileTabs,
	writeFileTabs,
	writePanelWidth,
} from './file-tabs.js'

describe('file tabs', () => {
	it('opens a file once and activates it, carrying the line', () => {
		const a = openFileTab(emptyFileTabs, 'docs/a.md', 12)
		expect(a).toEqual({ paths: ['docs/a.md'], active: 'docs/a.md', browsing: false, line: 12 })
		const again = openFileTab(a, 'docs/a.md')
		expect(again.paths).toEqual(['docs/a.md'])
		expect(again.line).toBeUndefined()
	})
	it('closes the active tab onto its right neighbour, then its left', () => {
		let state = emptyFileTabs
		for (const path of ['a', 'b', 'c']) state = openFileTab(state, path)
		state = activateFileTab(state, 'b')
		state = closeFileTab(state, 'b')
		expect(state.active).toBe('c')
		state = closeFileTab(state, 'c')
		expect(state.active).toBe('a')
		state = closeFileTab(state, 'a')
		expect(state).toMatchObject({ paths: [], active: undefined })
	})
	it('keeps the active file when another closes', () => {
		let state = openFileTab(openFileTab(emptyFileTabs, 'a'), 'b')
		state = closeFileTab(state, 'a')
		expect(state).toMatchObject({ paths: ['b'], active: 'b' })
	})
	it('drops the oldest other tab past the cap', () => {
		let state = emptyFileTabs
		for (let index = 0; index <= MAX_FILE_TABS; index++) state = openFileTab(state, `f${index}`)
		expect(state.paths).toHaveLength(MAX_FILE_TABS)
		expect(state.paths).not.toContain('f0')
		expect(state.active).toBe(`f${MAX_FILE_TABS}`)
	})
	it('browses and leaves without closing files', () => {
		const state = browseFileTabs(openFileTab(emptyFileTabs, 'a'))
		expect(state.browsing).toBe(true)
		expect(leaveFileTabs(state)).toMatchObject({ paths: ['a'], active: undefined, browsing: false })
	})
	it('round-trips through storage and rejects damaged records', () => {
		const state = openFileTab(openFileTab(emptyFileTabs, 'a'), 'b')
		expect(parseFileTabs(serializeFileTabs(state))).toEqual({
			paths: ['a', 'b'],
			active: 'b',
			browsing: false,
		})
		expect(parseFileTabs('{"paths":[1,"a","a"],"active":"zz"}')).toEqual({
			paths: ['a'],
			active: undefined,
			browsing: false,
		})
		expect(parseFileTabs('nope')).toEqual(emptyFileTabs)
		expect(parseFileTabs('x'.repeat(5000))).toEqual(emptyFileTabs)
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
		expect(readFileTabs(broken, 's')).toEqual(emptyFileTabs)
		expect(() => writeFileTabs(broken, 's', openFileTab(emptyFileTabs, 'a'))).not.toThrow()
		expect(readPanelWidth(broken, 'p')).toBeUndefined()
		expect(() => writePanelWidth(broken, 'p', 400)).not.toThrow()
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
