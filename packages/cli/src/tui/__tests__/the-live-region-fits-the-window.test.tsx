/**
 * A reply being written, the plan under the working line, a running command and a queued message
 * share one live region, and together they must never be as tall as the window: a region that is
 * makes the renderer clear the terminal and print everything again.
 *
 * The part of the reply kept live is cut to what is left after the rest (`flowRows`, handed to the
 * reply through the app's flow context); this drives a rendered `<App>` on an emulated terminal, since
 * only the screen shows whether that arrives.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const REPLY_WORDS = 300

/** Held open by the mocked session so the turn stays in progress while the screen is read. */
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
			toolNames: () => ['bash'],
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
			send: async function* (): AsyncIterable<AgentEvent> {
				for (let i = 1; i <= 7; i++) {
					yield {
						kind: 'task',
						taskId: `t${i}`,
						subject: `Plan step ${i}`,
						status: i === 1 ? 'in_progress' : 'pending',
					}
				}
				yield {
					kind: 'tool-start',
					toolUseId: 'call-1',
					toolName: 'bash',
					summary: 'sleep 600',
					command: 'sleep 600',
				} as AgentEvent
				// One paragraph that stays open, handed over whole: the tallest unfinished part a reply can have.
				const words = Array.from(
					{ length: REPLY_WORDS },
					(_, i) => `word${String(i + 1).padStart(3, '0')}`,
				)
				yield { kind: 'delta', text: `${words.join(' ')} ` }
				await new Promise<void>((resolve) => {
					release = resolve
				})
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

const ESC = '\u001b'
const ERASE = new RegExp(`^(?:${ESC}\\[2K(?:${ESC}\\[1A)?)+${ESC}\\[G`)
/** How many lines a write starts by erasing (Ink's way of taking back its last frame). */
const erasedLines = (chunk: string): number =>
	(ERASE.exec(chunk)?.[0].split(`${ESC}[2K`).length ?? 1) - 1

describe('the live region with a plan, a running command and a queued message', () => {
	for (const [cols, rows] of [
		[80, 24],
		[80, 16],
	] as const) {
		it(`never reaches the height of a ${cols}x${rows} window`, async () => {
			vi.useFakeTimers({
				toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
			})
			const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows })
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
			screen.press('go')
			await screen.waitForRender()
			screen.press('\r')
			// The whole reply has been written and the turn is still open.
			await settleUntil(() => text().includes(`word${REPLY_WORDS}`))
			// A message typed while the turn runs waits its turn.
			screen.press('and then this')
			await screen.waitForRender()
			screen.press('\r')
			await settleUntil(() => text().includes('and then this'))

			const bytes = screen.writes().join('')
			// On the renderer's own writing (no painter in between), a region as tall as the window is what
			// makes it clear the terminal and write everything again.
			expect(bytes, 'the renderer cleared the terminal').not.toContain(`${ESC}[2J`)
			expect(bytes).not.toContain(`${ESC}[3J`)
			// The tallest frame the renderer erased and wrote again (it erases one line more than the frame has)
			// was shorter than the window.
			const heights = screen.writes().map((chunk) => erasedLines(chunk))
			expect(Math.max(...heights) - 1, 'a frame as tall as the window').toBeLessThan(rows)
			// Every word of the reply stands once, in order: none lost, none written twice.
			const seen = [...text().matchAll(/word(\d\d\d)/gu)].map((m) => Number(m[1]))
			const unique = [...new Set(seen)]
			expect(seen.length, 'a word was written twice').toBe(unique.length)
			expect(unique).toEqual([...unique].sort((a, b) => a - b))
			// The plan, the command and the queued message, and the composer are on the visible screen
			// at once: nothing of the live region has been pushed above its top.
			const visible = screen.viewport().join('\n')
			expect(visible).toContain('Plan step 1')
			expect(visible).toContain('sleep 600')
			expect(visible).toContain('and then this')
		})
	}
})
