/**
 * A message interrupted before the model has shown anything of an answer goes back to the box and
 * leaves the transcript; once any text has arrived it stays where it was, with the
 * "Interrupted" row under it and the box empty.
 *
 * Driven through `<App>`: only the app knows what the model has shown and what the box holds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** What the mocked session writes before it holds the turn open (an interrupt); empty writes nothing. */
let replyText = ''
let holdOpen = true
/** What each send was handed, so a test can see whether an interrupted message is still in the history. */
const sent: string[][] = []
/** Held open by the mocked session so the turn stays in progress until the person interrupts it. */
let release: () => void = () => {}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
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
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (messages, opts): AsyncIterable<AgentEvent> {
				sent.push(messages.map((message) => String(message.content)))
				if (replyText !== '') yield { kind: 'delta', text: replyText }
				if (holdOpen) {
					// Held until the person interrupts, then ends the way a real session does: an aborted error.
					await new Promise<void>((resolve) => {
						release = resolve
						opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
					})
					if (opts?.signal?.aborted) {
						yield { kind: 'error', message: 'aborted' } as AgentEvent
						return
					}
				}
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const mounted: Screen[] = []

afterEach(async () => {
	release()
	vi.useRealTimers()
	for (const screen of mounted.splice(0)) await screen.unmount()
	vi.clearAllMocks()
})

async function start(): Promise<{
	screen: Screen
	settleUntil: (p: () => boolean) => Promise<void>
}> {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	})
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 30 })
	mounted.push(screen)
	const settleUntil = async (predicate: () => boolean) => {
		// The clock is the test's: the reply's pacing and the model's pieces are timers.
		for (let i = 0; i < 2000 && !predicate(); i++) {
			await vi.advanceTimersByTimeAsync(40)
			await screen.waitForRender()
		}
		expect(predicate()).toBe(true)
	}
	await settleUntil(() => screen.scrollback().join('\n').includes('a-model'))
	return { screen, settleUntil }
}

const linesWith = (screen: Screen, needle: string) =>
	screen.viewport().filter((row) => row.includes(needle)).length

describe('a message interrupted before anything was answered', () => {
	it('goes back to the box, leaves the transcript, and is not part of the next send', async () => {
		sent.length = 0
		replyText = ''
		holdOpen = true
		const { screen, settleUntil } = await start()
		screen.press('show me the totals')
		await screen.waitForRender()
		screen.press('\r')
		await settleUntil(() => sent.length === 1)
		screen.press('\u001b')
		// The words are in the box once, and nowhere else: no transcript row, no "Interrupted" row.
		await settleUntil(() => !screen.viewport().join('\n').includes('esc to interrupt'))
		expect(linesWith(screen, 'show me the totals')).toBe(1)
		expect(screen.viewport().join('\n')).not.toContain('Interrupted')
		expect(screen.scrollback().join('\n')).not.toContain('Interrupted')

		// Sent again (edited), the first copy is not in what the model is handed.
		holdOpen = false
		screen.press('\r')
		await settleUntil(() => sent.length === 2)
		const second = sent[1] ?? []
		expect(second.filter((content) => content.includes('show me the totals')).length).toBe(1)
	})

	it('stays in the transcript with the Interrupted row once the model has written something', async () => {
		sent.length = 0
		replyText = 'Looking at the files now.'
		holdOpen = true
		const { screen, settleUntil } = await start()
		screen.press('show me the totals')
		await screen.waitForRender()
		screen.press('\r')
		await settleUntil(() => screen.viewport().join('\n').includes('Looking at the files'))
		screen.press('\u001b')
		await settleUntil(() => screen.scrollback().join('\n').includes('Interrupted'))
		expect(screen.scrollback().concat(screen.viewport()).join('\n')).toContain('show me the totals')
		// The box is empty: the words are in the transcript only.
		expect(linesWith(screen, 'show me the totals')).toBe(1)
		expect(screen.viewport().join('\n')).toContain('Type a message')
	})

	it('stays where it is when the box already holds something else', async () => {
		sent.length = 0
		replyText = ''
		holdOpen = true
		const { screen, settleUntil } = await start()
		screen.press('show me the totals')
		await screen.waitForRender()
		screen.press('\r')
		await settleUntil(() => sent.length === 1)
		screen.press('and the dates')
		await screen.waitForRender()
		screen.press('\u001b')
		await settleUntil(() => screen.scrollback().join('\n').includes('Interrupted'))
		expect(screen.viewport().join('\n')).toContain('and the dates')
	})
})
