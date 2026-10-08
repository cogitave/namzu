import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessView } from '../shared/protocol.js'
import { EnginePanel, committableEngine, engineLabel, engineRowNote } from './harness-picker.js'

const view: HarnessView = {
	selected: 'namzu',
	locked: false,
	engines: [
		{ id: 'namzu', label: 'Namzu', available: true },
		{ id: 'codex-cli', label: 'Codex CLI', available: true },
		{ id: 'claude-code', label: 'Claude Code', available: false },
	],
}
const idle = { busy: false, disabled: false }

describe('committableEngine', () => {
	it('commits an available engine', () => {
		expect(committableEngine(view, 'codex-cli', idle)).toBe('codex-cli')
	})
	it('refuses an engine that is not installed', () => {
		expect(committableEngine(view, 'claude-code', idle)).toBeUndefined()
	})
	it('refuses unknown values and a missing view', () => {
		expect(committableEngine(view, 'other', idle)).toBeUndefined()
		expect(committableEngine(undefined, 'namzu', idle)).toBeUndefined()
	})
	it('refuses while busy or disabled', () => {
		expect(committableEngine(view, 'codex-cli', { busy: true, disabled: false })).toBeUndefined()
		expect(committableEngine(view, 'codex-cli', { busy: false, disabled: true })).toBeUndefined()
	})
})

describe('engineRowNote', () => {
	const [namzu, codex, unavailable] = view.engines
	it('says an unavailable engine is not installed, even on a started conversation', () => {
		expect(engineRowNote(view, unavailable)).toBe('Not installed')
		expect(engineRowNote({ ...view, locked: true }, unavailable)).toBe('Not installed')
	})
	it('says another engine opens a new tab only once the conversation has started', () => {
		expect(engineRowNote(view, codex)).toBeUndefined()
		expect(engineRowNote({ ...view, locked: true }, codex)).toBe('Opens in a new tab')
	})
	it('has no note on the engine in force', () => {
		expect(engineRowNote({ ...view, locked: true }, namzu)).toBeUndefined()
	})
})

describe('engineLabel', () => {
	it('uses the host label, then a built-in one', () => {
		expect(engineLabel(view, 'codex-cli')).toBe('Codex CLI')
		expect(engineLabel(undefined, 'claude-code')).toBe('Claude Code')
	})
})

describe('EnginePanel', () => {
	const render = (engineView: HarnessView, backLabel: 'Effort' | 'Models' = 'Effort') =>
		renderToStaticMarkup(
			createElement(EnginePanel, {
				view: engineView,
				backLabel,
				busy: false,
				disabled: false,
				onBack: vi.fn(),
				onSelect: vi.fn(),
			}),
		)
	it('titles the view, names where Back goes and checks the current engine', () => {
		const html = render(view, 'Models')
		expect(html).toContain('Choose an engine')
		expect(html).toMatch(/engine-panel-back[^>]*>.*Models/)
		expect(html.match(/aria-checked="true"/g)).toHaveLength(1)
		expect(html).toContain('Not installed')
		expect(html).not.toContain('Opens in a new tab')
	})
	it('says other available engines open a new tab on a started conversation', () => {
		const html = render({ ...view, locked: true })
		expect(html.match(/Opens in a new tab/g)).toHaveLength(1)
		expect(html).toContain('Not installed')
	})
})
