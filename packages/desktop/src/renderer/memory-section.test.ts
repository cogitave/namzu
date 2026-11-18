import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { MemoryRows } from './memory-section.js'
import type { InstructionsControls, SavedMemoryControls } from './use-memory-controls.js'

const instructions = (over: Partial<InstructionsControls> = {}): InstructionsControls => ({
	supported: true,
	loading: false,
	view: { text: 'Keep it short.', limit: 32_000, locked: false },
	save: vi.fn(async () => true),
	...over,
})
const memory = (over: Partial<SavedMemoryControls> = {}) => ({
	supported: true,
	loading: false,
	view: { project: true, memories: [] },
	reload: () => {},
	read: vi.fn(),
	update: vi.fn(),
	remove: vi.fn(),
	open: false,
	setOpen: () => {},
	...over,
})
const draw = (props: Partial<Parameters<typeof MemoryRows>[0]> = {}) =>
	renderToStaticMarkup(
		createElement(MemoryRows, {
			instructions: instructions(),
			memory: memory(),
			hasProject: true,
			projectName: 'App',
			...props,
		}),
	)

it('draws the instructions box with the saved text and says clearing removes it', () => {
	const html = draw()
	expect(html).toContain('id="setting-standingInstructions"')
	expect(html).toContain('Keep it short.')
	expect(html).toContain('Leave it empty to remove it')
	expect(html).toContain('Up to 32,000 characters')
	expect(html).toContain('Showing what is saved for App.')
})

it('draws the memory row with a Manage button, off until a project is open', () => {
	expect(draw()).toMatch(/<button[^>]*>Manage<\/button>/)
	const none = draw({ hasProject: false, projectName: undefined })
	expect(none).toContain('Open a project to see what is saved for it.')
	expect(none).toMatch(/<button[^>]*disabled[^>]*>Manage<\/button>/)
})

it('says a linked instructions file can only be changed by hand', () => {
	const html = draw({
		instructions: instructions({ view: { text: '', limit: 32_000, locked: true } }),
	})
	expect(html).toContain('can only be changed by hand')
	expect(html).toMatch(/<textarea[^>]*disabled/)
})

it('draws a row only for what the engine can do', () => {
	expect(draw({ instructions: instructions({ supported: false }) })).not.toContain(
		'setting-standingInstructions',
	)
	expect(draw({ memory: memory({ supported: false }) })).not.toContain('setting-savedMemory')
})

it('draws no technical words: no file name, path or key', () => {
	const html = draw()
	expect(html).not.toMatch(/AGENTS|\.md|NAMZU_HOME|~\//)
})
