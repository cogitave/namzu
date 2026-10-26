/**
 * `/theme` end to end in the App: the picker previews the highlighted row,
 * Esc puts the saved theme back, Enter saves it to the user config, and a name
 * after the command applies it without the picker.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Message } from '@namzu/sdk'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => {
		const { SessionPaths } = await import('@namzu/sdk')
		return {
			tenantId: 'ffdee53d-8d81-4568-b200-16a0c30cbb2f',
			projectId: 'b908c84b-ed5b-4dc3-aae8-e3483885fc5f',
			topicId: 'b9b7cdfe-6476-4e49-9af7-15d0a7e6c502',
			root: '/tmp/.namzu',
			paths: new SessionPaths({ home: '/tmp/.namzu', slug: '-tmp' }),
		}
	},
	startConversation: async () => '0dd41fd1-f1a5-44cf-8b18-619da7d08376',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'OpenAI (Codex subscription)',
			modelSummary: 'gpt-test',
			toolNames: () => [],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the picker test')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (messages: readonly Message[]) {
				const latest = messages.at(-1)
				void latest
				yield {
					kind: 'delta',
					text: 'A completed answer with an exact feedback identity.',
					turnId: '9a344531-d11f-45be-8b1b-1ee6a6975fbb',
					messageId: '1e2fbbcb-d241-4d76-a6b8-98ab03f68a06',
				} as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const { resetThemeStore, savedThemeSetting, shownTheme } = await import('../theme-store.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null
let home = ''

beforeAll(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-theme-app-'))
	vi.stubEnv('NAMZU_HOME', home)
})
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	resetThemeStore()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 80): Promise<void> {
	for (let i = 0; i < attempts && !predicate(); i++) await screen.waitForRender()
	expect(predicate()).toBe(true)
}

const DOWN = '\x1b[B'
const ESC = '\x1b'

async function openThemePicker(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 32 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('gpt-test'))
	screen.press('/theme')
	await screen.waitForRender()
	screen.press('\r')
	screen.press('\r')
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Light mode (ANSI colors only)'),
	)
	return screen
}

it('lists the seven rows with the saved one marked and a sample under them', async () => {
	const screen = await openThemePicker()
	const view = screen.viewport().join('\n')
	for (const label of [
		'Auto (match terminal)',
		'Dark mode',
		'Light mode',
		'Dark mode (colorblind-friendly)',
		'Light mode (colorblind-friendly)',
		'Dark mode (ANSI colors only)',
	]) {
		expect(view).toContain(label)
	}
	expect(view).toContain('[current]')
	expect(view).toContain('console.log("Hello, Namzu!");')
	expect(shownTheme()).toBe('dark')
})

it('previews the highlighted row and puts the saved theme back on Esc', async () => {
	const screen = await openThemePicker()
	// The saved theme (dark) is the second row, so one step down is Light mode.
	screen.press(DOWN)
	await waitUntil(screen, () => shownTheme() === 'light')
	expect(savedThemeSetting()).toBe('dark')
	// Ink holds a lone Esc until it is sure no escape sequence follows; the fake clock releases it.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		screen.press(ESC)
		await vi.advanceTimersByTimeAsync(100)
	} finally {
		vi.useRealTimers()
	}
	await waitUntil(screen, () => shownTheme() === 'dark')
	expect(savedThemeSetting()).toBe('dark')
	expect(() => readFileSync(join(home, 'config.yaml'), 'utf8')).toThrow()
})

it('saves the chosen theme on Enter and says so', async () => {
	const screen = await openThemePicker()
	// The saved theme (dark) is the second row, so one step down is Light mode.
	screen.press(DOWN)
	await waitUntil(screen, () => shownTheme() === 'light')
	screen.press('\r')
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('Theme set to Light mode.'))
	expect(savedThemeSetting()).toBe('light')
	expect(shownTheme()).toBe('light')
	expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toMatch(/theme: light/)
})

it('applies a named theme without the picker, and refuses an unknown one', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 32 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('gpt-test'))
	screen.press('/theme dark-ansi')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () =>
		screen.scrollback().join('\n').includes('Theme set to Dark mode (ANSI colors only).'),
	)
	expect(shownTheme()).toBe('dark-ansi')
	screen.press('/theme neon')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('Usage: /theme'))
	expect(shownTheme()).toBe('dark-ansi')
})
