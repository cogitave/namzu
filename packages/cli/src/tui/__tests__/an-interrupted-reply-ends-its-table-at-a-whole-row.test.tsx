/**
 * A reply the person interrupts (Esc) while a markdown table is being written is kept up to the
 * table's last whole row; the unfinished row stays as one line of plain text under it, never as a
 * row of empty cells. A reply that ends by itself keeps its last row in the table.
 *
 * Driven through `<App>`: `endTableAtWholeRow` is tested alone, but only the app decides when a
 * reply counts as cut off.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** What the mocked session writes, and whether it then holds the turn open (an interrupt) or ends it. */
let replyText = ''
let holdOpen = true
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
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: replyText }
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

const TABLE_HEAD = '| Name | Score |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |\n'

/** Types a message, lets the mocked reply stream, runs `afterReply`, and gives the scrollback. */
async function runTurn(
	reply: string,
	hold: boolean,
	afterReply: (screen: Screen, settleUntil: (p: () => boolean) => Promise<void>) => Promise<void>,
): Promise<string[]> {
	replyText = reply
	holdOpen = hold
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	})
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 30 })
	mounted.push(screen)
	const text = () => screen.scrollback().join('\n')
	const settleUntil = async (predicate: () => boolean) => {
		// The clock is the test's: the reply's pacing and the model's pieces are timers.
		for (let i = 0; i < 2000 && !predicate(); i++) {
			await vi.advanceTimersByTimeAsync(40)
			await screen.waitForRender()
		}
		expect(predicate()).toBe(true)
	}
	await settleUntil(() => text().includes('a-model'))
	screen.press('show me')
	await screen.waitForRender()
	screen.press('\r')
	await afterReply(screen, settleUntil)
	return screen.scrollback()
}

const occurrences = (rows: string[], needle: string) =>
	rows.filter((row) => row.includes(needle)).length

describe('a table in a reply that is cut off or finished', () => {
	it('ends at its last whole row when the person interrupts, with the half row as plain text', async () => {
		const rows = await runTurn(`${TABLE_HEAD}| gamma | half`, true, async (screen, settleUntil) => {
			await settleUntil(() => screen.scrollback().join('\n').includes('beta'))
			// The reply is paced: let the clock run until the half row has been handed over too.
			for (let i = 0; i < 100; i++) {
				await vi.advanceTimersByTimeAsync(40)
				await screen.waitForRender()
			}
			screen.press('\u001b')
			await settleUntil(() => screen.scrollback().join('\n').includes('Interrupted'))
		})
		const wholeRows = rows.filter((row) => row.includes('alpha') || row.includes('beta'))
		expect(wholeRows.length).toBe(2)
		// The whole rows are inside the table: drawn with its border characters.
		for (const row of wholeRows) expect(row).toMatch(/[│|┃]/u)
		// The half row is there once, as plain words: no border, no cells added around it.
		expect(occurrences(rows, 'gamma')).toBe(1)
		const half = rows.find((row) => row.includes('gamma')) ?? ''
		expect(half).not.toMatch(/[│┃┌┐└┘├┤┬┴┼─]/u)
		expect(half.trim()).toBe('| gamma | half')
		expect(rows.findIndex((row) => row.includes('Interrupted'))).toBeGreaterThan(
			rows.findIndex((row) => row.includes('gamma')),
		)
	})

	it('keeps a last row that has no trailing pipe in the table when the reply ends by itself', async () => {
		const rows = await runTurn(`${TABLE_HEAD}| gamma | 3\n`, false, async (screen, settleUntil) => {
			await settleUntil(() => screen.scrollback().join('\n').includes('gamma'))
			await settleUntil(() => !screen.viewport().join('\n').includes('esc to interrupt'))
		})
		expect(occurrences(rows, 'gamma')).toBe(1)
		const last = rows.find((row) => row.includes('gamma')) ?? ''
		expect(last).toMatch(/[│|┃]/u)
		expect(rows.join('\n')).not.toContain('Interrupted')
	})
})
