/**
 * A paragraph that takes a while is shown a sentence at a time.
 *
 * `a-reply-arrives-in-whole-blocks` pins the block rule: text is released a
 * paragraph at a time, never mid-word. The rule has a hole that file cannot
 * see because its reply streams in a few milliseconds: a model's paragraph
 * is ONE line, so nothing of it is released until its final character, and
 * a long paragraph arriving over twenty seconds is a blank row for twenty
 * seconds. The operator reads that as "it stopped".
 *
 * These stream a single long paragraph slowly enough to cross
 * `STREAM_RELEASE_MS` and assert that a sentence of it is on screen before
 * the reply ends — while still never showing a half-written word, which is
 * the block rule's actual promise and the one this must keep.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/**
 * One paragraph, no newline anywhere, three sentences. Each sentence is
 * short enough not to be wrapped by the test terminal, so it can be looked
 * for whole; the paragraph as a whole is not, and is never asserted on.
 */
const SENTENCES = ['The first sentence lands early.', 'Then a pause.', 'The third is the tail.']
const SLOW_PARAGRAPH = SENTENCES.join(' ')
/** Per-character delay: the whole reply takes ~1.5 s, well past the release interval. */
const DELAY_MS = 15

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
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
			toolNames: () => ['bash'],
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
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				for (const ch of SLOW_PARAGRAPH) {
					yield { kind: 'delta', text: ch } as AgentEvent
					await new Promise((r) => setTimeout(r, DELAY_MS))
				}
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function frameShows(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if ((read() ?? '').includes(needle)) return
		await tick(20)
	}
}

async function runTurnCapturing(): Promise<{ frames: string[]; final: string }> {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')

	const frames: string[] = []
	const deadline = Date.now() + 8000
	while (Date.now() < deadline) {
		const f = harness.lastFrame() ?? ''
		if (frames[frames.length - 1] !== f) frames.push(f)
		if (f.includes('is the tail.')) break
		await tick(10)
	}
	return { frames, final: harness.lastFrame() ?? '' }
}

describe('a slow single-paragraph reply', () => {
	it('shows its first sentence before the paragraph has finished', async () => {
		const { frames } = await runTurnCapturing()
		const partway = frames.filter(
			(f) => f.includes('The first sentence lands early.') && !f.includes('is the tail.'),
		)
		expect(partway.length, 'the first sentence was never shown on its own').toBeGreaterThan(0)
	})

	it('still never shows a half-written word', async () => {
		const { frames } = await runTurnCapturing()
		for (const frame of frames) {
			if (frame.includes('The first sen')) {
				expect(frame, 'a partial word was rendered').toContain('The first sentence lands early.')
			}
			if (frame.includes('Then a pau')) {
				expect(frame, 'a partial word was rendered').toContain('Then a pause.')
			}
		}
	})

	it('loses nothing and duplicates nothing', async () => {
		const { final } = await runTurnCapturing()
		expect(final).toContain(SLOW_PARAGRAPH)
		expect(final.split('The first sentence lands early.').length - 1).toBe(1)
	})
})
