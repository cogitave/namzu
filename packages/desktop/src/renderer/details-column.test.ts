import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ConversationDetailsBody, toolServerRows } from './conversation-details.js'
import {
	DETAILS_COLUMN_MIN_WINDOW,
	DETAILS_COLUMN_QUERY,
	detailsToggleAction,
	readDetailsColumn,
	writeDetailsColumn,
} from './details-column.js'
import {
	detailsTab,
	emptyPanelTabs,
	ensurePanelTab,
	panelKindOf,
	parsePanelTabs,
	serializePanelTabs,
} from './file-panel/file-tabs.js'
import { tabLabel } from './file-panel/panel-tabs.js'
import type { OutputFile } from './outputs-model.js'

const memory = () => {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
	}
}

describe('the details column', () => {
	it('is a column from 1500 px wide and a pane tab below', () => {
		expect(DETAILS_COLUMN_MIN_WINDOW).toBe(1500)
		expect(DETAILS_COLUMN_QUERY).toBe('(min-width: 1500px)')
		expect(detailsToggleAction({ wide: true, pane: false })).toBe('column')
		expect(detailsToggleAction({ wide: true, pane: true })).toBe('column')
		expect(detailsToggleAction({ wide: false, pane: false })).toBe('pane-open')
		expect(detailsToggleAction({ wide: false, pane: true })).toBe('pane-close')
	})

	it('remembers whether it was open, and survives blocked storage', () => {
		const storage = memory()
		expect(readDetailsColumn(storage)).toBe(false)
		writeDetailsColumn(storage, true)
		expect(readDetailsColumn(storage)).toBe(true)
		writeDetailsColumn(storage, false)
		expect(readDetailsColumn(storage)).toBe(false)
		const blocked = {
			getItem: () => {
				throw new Error('blocked')
			},
			setItem: () => {
				throw new Error('blocked')
			},
		}
		expect(readDetailsColumn(blocked)).toBe(false)
		expect(() => writeDetailsColumn(blocked, true)).not.toThrow()
	})

	it('is a tab that leads, is a tool panel, is named Details and is stored', () => {
		const state = ensurePanelTab(emptyPanelTabs, detailsTab)
		expect(state.tabs.map((tab) => tab.kind)).toEqual(['details', 'changes', 'activity'])
		expect(state.active).toEqual(detailsTab)
		expect(panelKindOf('details')).toBe('tool')
		expect(tabLabel(detailsTab)).toBe('Details')
		const back = parsePanelTabs(serializePanelTabs(state))
		expect(back.tabs.map((tab) => tab.kind)).toEqual(['details', 'changes', 'activity'])
		expect(back.active).toEqual(detailsTab)
	})

	it('lays out as 320 px beside the conversation, with the panel kept to its side', () => {
		const css = readFileSync(new URL('./conversation-details.css', import.meta.url), 'utf8')
		const style = readFileSync(new URL('./style.css', import.meta.url), 'utf8')
		expect(css).toContain('--details-column-width: 320px')
		expect(css).toMatch(/\.details-column \{[^}]*width: var\(--details-column-width\)/)
		expect(css).toMatch(
			/\.workspace\.jobs-open \.details-column \{[^}]*inset-inline-end: var\(--panel-width\)/,
		)
		expect(css).toMatch(/\.details-section \{[^}]*padding: 16px 16px 20px/)
		expect(css).toMatch(/\.details-row \{[^}]*height: 32px/)
		// The transcript gives up the column's width, and so does what the panel may take.
		expect(style).toContain('.workspace[data-details-column]')
		expect(style).toContain('.workspace[data-details-shown] .turn-result')
	})
})

const output = (name: string): OutputFile => ({
	path: `cafe/${name}`,
	name,
	folder: 'cafe',
	kind: 'code',
	turn: 1,
	version: 1,
	created: true,
	cardKind: 'code',
})

const draw = (over: Partial<Parameters<typeof ConversationDetailsBody>[0]> = {}) =>
	renderToStaticMarkup(
		createElement(ConversationDetailsBody, {
			where: 'This computer',
			project: { name: 'cafe', path: '/work/cafe' },
			branch: 'main',
			outputs: [output('menu.ts'), output('notes.txt')],
			onOpenOutput: () => {},
			totals: { added: 556, removed: 0, files: 3, cut: false },
			onOpenChanges: () => {},
			work: { state: 'checking' },
			onOpenWork: () => {},
			...over,
		}),
	)

describe('the details body', () => {
	it('holds Environment, Outputs and Changes in that order, with the facts', () => {
		const out = draw()
		const at = (name: string) => out.indexOf(`aria-label="${name}"`)
		expect(at('Environment')).toBeGreaterThan(-1)
		expect(at('Environment')).toBeLessThan(at('Outputs'))
		expect(at('Outputs')).toBeLessThan(at('Changes'))
		expect(out).toContain('This computer')
		expect(out).toContain('>cafe<')
		expect(out).toContain('>main<')
		expect(out.match(/data-output-row=/g)).toHaveLength(2)
		expect(out).toContain('Review changes')
		expect(out).toContain('556')
	})

	it('leaves out what it has nothing to say about', () => {
		const out = draw({
			project: undefined,
			branch: null,
			outputs: [],
			totals: { added: 0, removed: 0, files: 0, cut: false },
		})
		expect(out).not.toContain('data-details-row="folder"')
		expect(out).not.toContain('data-details-row="branch"')
		expect(out).not.toContain('Tool servers')
		expect(out).not.toContain('Background work')
		expect(out).not.toContain('aria-label="Context"')
		expect(out).toContain('Files this conversation writes show up here.')
		expect(out).toContain('No file changes yet.')
	})

	it('draws the context inline, with no frame of its own, when it can be read', () => {
		const out = draw({ context: { ask: () => Promise.resolve(null) } })
		expect(out).toContain('aria-label="Context"')
		expect(out).toContain('class="context-panel"')
		expect(out).not.toContain('context-panel-frame')
	})

	it('shows background work only when it is running or needs a look', () => {
		expect(draw({ work: { state: 'known', running: 0, needsAttention: false } })).not.toContain(
			'Background work',
		)
		const busy = draw({ work: { state: 'known', running: 2, needsAttention: false } })
		expect(busy).toContain('Background work')
		expect(busy).toContain('2 running')
	})

	it('lists the tool servers by name with a plain count', () => {
		expect(
			toolServerRows([
				{ name: 'files', count: 1 },
				{ name: 'web', count: 12 },
			]),
		).toEqual([
			{ name: 'files', label: '1 tool' },
			{ name: 'web', label: '12 tools' },
		])
		expect(toolServerRows(undefined)).toEqual([])
	})
})
