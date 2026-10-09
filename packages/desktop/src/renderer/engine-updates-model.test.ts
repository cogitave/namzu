import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { EngineUpdateItem, EngineUpdatesState } from '../shared/engine-update-protocol.js'
import type { HarnessView } from '../shared/protocol.js'
import type { UpdateState } from '../shared/update-protocol.js'
import {
	availableEngineUpdates,
	engineAnnouncement,
	engineBadge,
	engineRowView,
	engineToastText,
	engineUpdateNote,
} from './engine-updates-model.js'
import { EngineUpdateRows } from './engine-updates-section.js'
import { EngineChip, EnginePanel } from './harness-picker.js'
import { NavigationRail } from './navigation-rail.js'
import { EngineUpdatesContext, type EngineUpdatesControls } from './use-engine-updates.js'

const codex: EngineUpdateItem = {
	id: 'codex-cli',
	name: 'Codex CLI',
	package: '@openai/codex',
	installed: '0.154.0',
	latest: '0.162.0',
	method: 'npm-global',
	status: 'available',
	checkedAt: 5,
	command: 'npm install -g @openai/codex@latest',
	runnable: true,
	note: 'Installed with npm',
}
const second: EngineUpdateItem = {
	id: 'claude-code',
	name: 'Claude Code',
	package: '@anthropic-ai/claude-code',
	installed: '2.1.295',
	latest: '2.1.295',
	method: 'native',
	status: 'current',
	runnable: true,
	note: 'Installed by its own installer',
}
const namzu: EngineUpdateItem = {
	id: 'namzu-cli',
	name: 'Namzu command line',
	package: '@namzu/cli',
	installed: '35.0.0',
	method: 'bundled',
	status: 'current',
	bundled: true,
	runnable: false,
	note: 'Bundled with Namzu Desktop, so it updates with the app.',
}
const state = (...items: EngineUpdateItem[]): EngineUpdatesState => ({ items, checking: false })

describe('a row of Settings ▸ Updates', () => {
	it('reads installed → latest, offers Update and shows the command before it runs', () => {
		expect(engineRowView(codex)).toEqual({
			title: 'Codex CLI',
			versions: '0.154.0 → 0.162.0',
			status: 'Update available',
			tone: 'attention',
			note: 'Installed with npm',
			action: 'update',
			command: 'npm install -g @openai/codex@latest',
			busy: false,
		})
	})
	it('says Up to date with no button, and adds the restart note after an update', () => {
		expect(engineRowView(second)).toMatchObject({ status: 'Up to date', versions: '2.1.295' })
		expect(engineRowView(second).action).toBeUndefined()
		expect(engineRowView({ ...second, updated: true }).note).toBe(
			'Installed by its own installer · Open conversations use the new version after they restart.',
		)
	})
	it('shows Updating… as a busy button, and a failure with the reason and Try again', () => {
		expect(engineRowView({ ...codex, status: 'updating' })).toMatchObject({
			status: 'Updating…',
			busy: true,
		})
		expect(engineRowView({ ...codex, status: 'updating' }).action).toBeUndefined()
		expect(
			engineRowView({
				...codex,
				status: 'failed',
				error: 'Close other Codex CLI windows and try again.',
			}),
		).toMatchObject({
			status: 'Update failed',
			tone: 'error',
			action: 'retry',
			note: 'Close other Codex CLI windows and try again.',
		})
	})
	it('offers Copy instead of a run for an install Namzu does not know', () => {
		expect(
			engineRowView({ ...codex, method: 'unknown', runnable: false, command: 'codex update' }),
		).toMatchObject({ action: 'copy', command: 'codex update' })
	})
	it('says Could not check quietly when the registry could not be reached, and Not installed for a missing program', () => {
		expect(engineRowView({ ...codex, status: 'unknown', latest: undefined })).toMatchObject({
			status: 'Could not check',
			versions: '0.154.0',
		})
		expect(
			engineRowView({ ...codex, installed: undefined, missing: true, status: 'unknown' }),
		).toMatchObject({
			status: 'Not installed',
		})
	})
	it('explains the bundled command line instead of offering an update', () => {
		expect(engineRowView(namzu)).toMatchObject({
			status: 'Up to date',
			note: 'Bundled with Namzu Desktop, so it updates with the app.',
		})
	})
})

describe('what is behind', () => {
	it('still counts a program whose update failed while it is behind', () => {
		const failed = { ...codex, status: 'failed' as const }
		expect(availableEngineUpdates(state(failed))).toEqual([failed])
		expect(availableEngineUpdates(state({ ...failed, installed: '0.162.0' }))).toEqual([])
	})
	it('lists only the available ones and words the badge for them', () => {
		const behind = state(codex, second, namzu)
		expect(availableEngineUpdates(behind)).toEqual([codex])
		expect(engineBadge(behind)).toEqual({
			visible: true,
			label: 'Updates available. Open Settings to update Codex CLI',
			tooltip: 'Update available for Codex CLI',
		})
		expect(
			engineBadge(state(codex, { ...second, status: 'available', latest: '2.1.296' })),
		).toMatchObject({
			label: 'Updates available. Open Settings to update Codex CLI and Claude Code',
		})
		expect(engineBadge(state(second, namzu))).toEqual({ visible: false })
		expect(engineBadge(undefined)).toEqual({ visible: false })
	})
	it('announces a program once when it first falls behind, and again for a newer version', () => {
		expect(engineAnnouncement(state(second), state(codex))).toBe('Update available for Codex CLI.')
		expect(engineAnnouncement(state(codex), state(codex))).toBe('')
		expect(engineAnnouncement(state(codex), state({ ...codex, latest: '0.163.0' }))).toBe(
			'Update available for Codex CLI.',
		)
	})
	it('words the model popup note and the launch toast', () => {
		expect(engineUpdateNote(state(codex), 'codex-cli')).toBe('Update available (0.162.0)')
		expect(engineUpdateNote(state(codex), 'claude-code')).toBeUndefined()
		expect(engineUpdateNote(state(second), 'claude-code')).toBeUndefined()
		expect(engineUpdateNote(undefined, 'codex-cli')).toBeUndefined()
		expect(engineUpdateNote(state(codex), 'namzu')).toBeUndefined()
		expect(engineToastText({ name: 'Codex CLI', version: '0.162.0' })).toBe(
			'Codex CLI 0.162.0 is available',
		)
	})
})

function controls(
	engines: EngineUpdatesState,
	over: Partial<EngineUpdatesControls> = {},
): EngineUpdatesControls {
	return {
		state: engines,
		check: vi.fn(),
		update: vi.fn(async () => ({ ok: true as const, tabId: 't' })),
		openUpdates: vi.fn(),
		registerOpenUpdates: vi.fn(() => () => undefined),
		...over,
	}
}
const provided = (
	value: EngineUpdatesControls | undefined,
	child: ReturnType<typeof createElement>,
) => createElement(EngineUpdatesContext.Provider, { value }, child)

describe('the rows in Settings', () => {
	const rows = (engines: EngineUpdatesControls | undefined) =>
		renderToStaticMarkup(
			provided(engines, createElement(EngineUpdateRows, { target: { groupId: 'g1' } })),
		)
	it('lists every program with its versions, state and an accessible Update button', () => {
		const markup = rows(controls(state(codex, second, namzu)))
		expect(markup).toContain('Programs Namzu works with')
		expect(markup).toContain('0.154.0 → 0.162.0')
		expect(markup).toContain('aria-label="Update Codex CLI"')
		expect(markup).toContain(
			'Runs in a new terminal tab: <code>npm install -g @openai/codex@latest</code>',
		)
		expect(markup).toContain('Up to date')
		expect(markup).toContain('Bundled with Namzu Desktop')
		expect(markup.match(/aria-label="Update /g)).toHaveLength(1)
	})
	it('shows Updating… as a disabled, busy button', () => {
		const markup = rows(controls(state({ ...codex, status: 'updating' })))
		expect(markup).toContain('aria-busy="true"')
		expect(markup).toContain('Updating…')
		expect(markup).not.toContain('aria-label="Update Codex CLI"')
	})
	it('offers Copy and no Update for an install it does not know', () => {
		const markup = rows(
			controls(state({ ...codex, method: 'unknown', runnable: false, command: 'codex update' })),
		)
		expect(markup).toContain('aria-label="Copy the Codex CLI update command"')
		expect(markup).not.toContain('aria-label="Update Codex CLI"')
		expect(markup).toContain('Run: <code>codex update</code>')
	})
	it('renders nothing where the window has no engine updates', () => {
		expect(rows(undefined)).toBe('')
		expect(rows(controls(state()))).toBe('')
	})
})

describe('the rail badge for programs that are behind', () => {
	const rail = (
		engines: EngineUpdatesControls | undefined,
		update?: UpdateState,
		withOpen = true,
	) =>
		renderToStaticMarkup(
			provided(
				engines,
				createElement(NavigationRail, {
					section: 'home',
					onHome: () => {},
					onSpaces: () => {},
					onPlugins: () => {},
					onSettings: () => {},
					onOpenProject: () => {},
					onToggleSidebar: () => {},
					...(withOpen ? { onOpenUpdates: () => {} } : {}),
					update: update ? { state: update, onOpen: () => {}, onCheck: () => {} } : undefined,
				}),
			),
		)
	it('is a labelled button above the profile control when a program is behind', () => {
		const markup = rail(controls(state(codex)), { status: 'idle' })
		const badge = markup.indexOf(
			'aria-label="Updates available. Open Settings to update Codex CLI"',
		)
		expect(badge).toBeGreaterThan(-1)
		expect(badge).toBeLessThan(markup.indexOf('aria-label="Profile"'))
	})
	it('shows without an app updater at all', () => {
		expect(rail(controls(state(codex)))).toContain('rail-update-button')
	})
	it('lets the app’s own restart keep priority', () => {
		const markup = rail(controls(state(codex)), { status: 'ready', version: '0.2.0' })
		expect(markup).toContain('Update ready. Restart Namzu to install version 0.2.0')
		expect(markup).not.toContain('Updates available. Open Settings')
	})
	it('is absent when nothing is behind or there is nowhere to open', () => {
		expect(rail(controls(state(second, namzu)), { status: 'idle' })).not.toContain(
			'rail-update-button',
		)
		expect(rail(controls(state(codex)), { status: 'idle' }, false)).not.toContain(
			'rail-update-button',
		)
		expect(rail(undefined, { status: 'idle' })).not.toContain('rail-update-button')
	})
})

describe('the engine view of the model popup', () => {
	const harness: HarnessView = {
		selected: 'namzu',
		locked: false,
		engines: [
			{ id: 'namzu', label: 'Namzu', available: true },
			{ id: 'codex-cli', label: 'Codex CLI', available: true },
			{ id: 'claude-code', label: 'Claude Code', available: true },
		],
	}
	it('adds a quiet Update available line under the engine that is behind, and only there', () => {
		const markup = renderToStaticMarkup(
			provided(
				controls(state(codex, second)),
				createElement(EnginePanel, {
					view: harness,
					backLabel: 'Models',
					busy: false,
					disabled: false,
					onBack: () => {},
					onSelect: () => {},
				}),
			),
		)
		expect(markup.match(/Update available \(0\.162\.0\)/g)).toHaveLength(1)
		expect(markup.indexOf('Update available')).toBeGreaterThan(markup.indexOf('Codex CLI'))
		expect(markup.indexOf('Update available')).toBeLessThan(markup.indexOf('Claude Code'))
	})
	it('marks the chip of an engine that is behind, for assistive technology too', () => {
		const chip = (engine: 'codex-cli' | 'claude-code') =>
			renderToStaticMarkup(
				provided(
					controls(state(codex, second)),
					createElement(EngineChip, {
						engine,
						label: engine === 'codex-cli' ? 'Codex CLI' : 'Claude Code',
						disabled: false,
						onClick: () => {},
					}),
				),
			)
		expect(chip('codex-cli')).toContain(
			'aria-label="Engine: Codex CLI. Update available (0.162.0)"',
		)
		expect(chip('codex-cli')).toContain('data-update="available"')
		expect(chip('claude-code')).toContain('aria-label="Engine: Claude Code"')
		expect(chip('claude-code')).not.toContain('data-update')
	})
})
