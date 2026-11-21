import type { Message, StopReason } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const sent: Message[][] = []
const sentOptions: SendOptions[] = []
const nextStopReason: StopReason = 'end_turn'
const saved: { path: readonly string[]; value: unknown }[] = []

/** A gate per provider turn, so a turn can be left running while keys are pressed. */
const turnGates: Array<{ wait: Promise<void>; release: () => void }> = []
function holdNextTurn(): void {
	let release: () => void = () => {}
	const wait = new Promise<void>((resolve) => {
		release = resolve
	})
	turnGates.push({ wait, release })
}

vi.mock('../../config/user-config.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../config/user-config.js')>()),
	setUserConfigValue: (path: readonly string[], value: unknown) => {
		saved.push({ path, value })
	},
}))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	activeConversationTurn: async () => undefined,
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

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
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
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
			// The TUI never resumes a durable turn; a stub that answered would
			// make a resume look reachable from here.
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (messages, options): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				sentOptions.push(options ?? {})
				const gate = turnGates.shift()
				if (gate) await gate.wait
				yield { kind: 'done', stopReason: nextStopReason } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const baseCtx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []
const ESC = '\x1B'

async function frameShows(lastFrame: () => string | undefined, text: string): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').toContain(text))
}
async function frameLacks(lastFrame: () => string | undefined, text: string): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').not.toContain(text))
}

beforeEach(() => {
	sent.length = 0
	sentOptions.length = 0
	saved.length = 0
	for (const gate of turnGates.splice(0)) gate.release()
})

afterEach(() => {
	for (const gate of turnGates.splice(0)) gate.release()
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function ready(ctx: TuiContext = baseCtx) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	return harness
}

async function type(harness: { stdin: { write: (value: string) => void } }, text: string) {
	for (const ch of text) {
		harness.stdin.write(ch)
		await tick(15)
	}
}

describe('/vim', () => {
	it('turns vim keys on, says so in one line, saves it, and shows the mode in the footer', async () => {
		const h = await ready()
		await type(h, '/vim')
		h.stdin.write('\r')
		await frameShows(h.lastFrame, 'Editor mode is vim')
		expect(saved).toEqual([{ path: ['tui', 'editorMode'], value: 'vim' }])
		await frameShows(h.lastFrame, '-- INSERT --')
		// Esc leaves insert mode: the footer says nothing in NORMAL.
		h.stdin.write(ESC)
		await frameLacks(h.lastFrame, '-- INSERT --')
		await type(h, 'v')
		await frameShows(h.lastFrame, '-- VISUAL --')
		await type(h, 'V')
		await frameShows(h.lastFrame, '-- VISUAL LINE --')
	})

	it('flips back with a second /vim, and names the mode the same way', async () => {
		const h = await ready({ ...baseCtx, tui: { editorMode: 'vim' } })
		await frameShows(h.lastFrame, '-- INSERT --')
		await type(h, '/vim')
		h.stdin.write('\r')
		await frameShows(h.lastFrame, 'Editor mode is normal')
		expect(saved).toEqual([{ path: ['tui', 'editorMode'], value: 'normal' }])
		await frameLacks(h.lastFrame, '-- INSERT --')
	})

	it('/vim off when it is already off changes nothing and saves nothing', async () => {
		const h = await ready()
		await type(h, '/vim off')
		h.stdin.write('\r')
		await frameShows(h.lastFrame, 'Editor mode is normal')
		expect(saved).toEqual([])
	})

	it('a launch with the setting on starts in INSERT', async () => {
		const h = await ready({ ...baseCtx, tui: { editorMode: 'vim' } })
		await frameShows(h.lastFrame, '-- INSERT --')
	})

	it('a launch without the setting shows no vim mode', async () => {
		const h = await ready()
		await tick(100)
		expect(h.lastFrame() ?? '').not.toContain('-- INSERT --')
	})

	it('is in the settings picker as Editor mode', async () => {
		const h = await ready()
		await type(h, '/settings')
		h.stdin.write('\r')
		await frameShows(h.lastFrame, 'Configuration')
		// The picker shows eight rows at a time; the filter brings the row up.
		await type(h, 'editor')
		await frameShows(h.lastFrame, 'Editor mode')
		await frameShows(h.lastFrame, 'the message box uses the usual keys')
	})
})

describe('Esc while a reply runs', () => {
	it('leaves INSERT first and stops the reply only from NORMAL', async () => {
		holdNextTurn()
		const h = await ready({ ...baseCtx, tui: { editorMode: 'vim' } })
		await type(h, 'go')
		h.stdin.write('\r')
		await vi.waitFor(() => expect(sent.length).toBe(1))
		await tick(60)
		h.stdin.write(ESC)
		await frameLacks(h.lastFrame, '-- INSERT --')
		await tick(60)
		expect(h.lastFrame() ?? '').not.toContain('Interrupted')
		expect(turnGates.length).toBe(0)
		h.stdin.write(ESC)
		// Nothing was answered yet: the message goes back to the box (vim starts it in INSERT)
		// instead of leaving an Interrupted row.
		await frameShows(h.lastFrame, '-- INSERT --')
		expect(h.lastFrame() ?? '').not.toContain('Interrupted')
	})
})
