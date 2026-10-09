import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HarnessView } from '../shared/protocol.js'
import {
	EngineInstallHelp,
	EnginePanel,
	SurfaceCaption,
	committableEngine,
	engineLabel,
	engineRowNote,
	surfaceCaption,
} from './harness-picker.js'

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
	it('turns a missing engine into a row that opens its install steps', () => {
		const html = render(view)
		expect(html).toContain('aria-expanded="false"')
		expect(html).toContain('<small>Not installed</small>')
		expect(html).toContain('How to install')
		// The row is no radio, so it is never a disabled dead end.
		expect(html).not.toContain('aria-disabled="true"')
		expect(html.match(/role="radio"/g)).toHaveLength(2)
	})
	it('says other available engines open a new tab on a started conversation', () => {
		const html = render({ ...view, locked: true })
		expect(html.match(/Opens in a new tab/g)).toHaveLength(1)
		expect(html).toContain('Not installed')
	})
})

describe('EngineInstallHelp', () => {
	const render = (engine: 'codex-cli' | 'claude-code', platform: 'windows' | 'mac' | 'linux') =>
		renderToStaticMarkup(
			createElement(EngineInstallHelp, { engine, platform, onRecheck: async () => {} }),
		)
	it('gives the exact command per system, a Copy button for each, and Check again', () => {
		const windows = render('claude-code', 'windows')
		expect(windows).toContain('irm https://claude.ai/install.ps1 | iex')
		expect(windows).not.toContain('install.sh')
		expect(windows).toContain('npm install -g @anthropic-ai/claude-code')
		expect(windows.match(/Copy: /g)).toHaveLength(2)
		expect(windows).toContain('Check again')
		const mac = render('claude-code', 'mac')
		expect(mac).toContain('curl -fsSL https://claude.ai/install.sh | bash')
		expect(render('codex-cli', 'linux')).toContain('npm install -g @openai/codex')
	})
})

describe('SurfaceCaption', () => {
	it('explains the side in force in one short line', () => {
		expect(surfaceCaption('desktop')).toBe('Desktop: you chat with this engine in this window.')
		expect(surfaceCaption('cli')).toBe('CLI: sending opens this engine in a terminal tab.')
		expect(renderToStaticMarkup(createElement(SurfaceCaption, { value: 'cli' }))).toContain(
			'terminal tab',
		)
	})
})
