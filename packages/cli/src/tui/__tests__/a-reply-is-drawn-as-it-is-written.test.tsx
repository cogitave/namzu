/**
 * A reply is drawn as it is written, and none of it is lost.
 *
 * The tail of a reply is drawn word by word as it arrives, and a finished
 * block is printed into the transcript at once. Both must hold the one thing
 * that matters: the last words of a reply are on screen when the turn ends. A
 * close path that forgets to flush drops the last paragraph of nearly every
 * answer, silently, on a turn that otherwise looks successful. The pure rules
 * are tested in `stream-flow.test.tsx` and cannot catch that: they never see a
 * turn end.
 *
 * So these drive a rendered `<App>` through a real turn. The claim is about
 * what is on the screen, which is the only thing that can establish it.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** The reply the mock streams, one character per delta. Set per test. */
const TWO_BLOCKS = 'First paragraph here.\n\nSecond paragraph, the tail.'
/**
 * The common case, and the one with no block boundary anywhere in it.
 *
 * A short answer has no blank line, so NO block ever completes and the whole
 * reply exists only in the buffer until the turn ends. If the flush cannot
 * create the bubble it never made, this answer is lost in its entirety — not
 * a paragraph of it, all of it.
 */
const ONE_BLOCK = 'A short answer with no blank line anywhere in it.'
let reply = TWO_BLOCKS
let separateMessages = false
/**
 * The reply waits on this gate after its first block, so "the first block is
 * on screen while the rest has not arrived" is a state the test holds the
 * stream in rather than a window it has to catch on a real clock.
 */
const gate = vi.hoisted(() => ({ open: () => {} }))
let holdAfter: string | null = null

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
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
				if (separateMessages) {
					yield { kind: 'delta', text: 'CLI review is running.', messageId: 'first' }
					yield { kind: 'delta', text: 'CLI review completed.', messageId: 'second' }
					yield { kind: 'done' }
					return
				}
				// One character per event: the shape that produced the typing
				// effect, and the shape that catches a splitter that releases a
				// partial word.
				const waiting = new Promise<void>((resolve) => {
					gate.open = resolve
				})
				let sent = ''
				for (const ch of reply) {
					yield { kind: 'delta', text: ch } as AgentEvent
					sent += ch
					await new Promise((r) => setTimeout(r, 0))
					if (holdAfter !== null && sent === holdAfter) await waiting
				}
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

// Imported after the mocks above are registered, the way the sibling App
// tests do it — a static import would bind the real modules first.
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
	reply = TWO_BLOCKS
	separateMessages = false
	holdAfter = null
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

/** Every frame drawn while the turn ran. `until` marks the end of the reply. */
async function runTurnCapturing(
	until = 'the tail.',
	releaseWhen?: string,
): Promise<{ frames: string[]; final: string }> {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')

	const frames: string[] = []
	const deadline = Date.now() + 4000
	let released = releaseWhen === undefined
	while (Date.now() < deadline) {
		const f = harness.lastFrame() ?? ''
		if (frames[frames.length - 1] !== f) frames.push(f)
		if (!released && releaseWhen !== undefined && f.includes(releaseWhen)) {
			released = true
			gate.open()
		}
		if (f.includes(until)) break
		await tick(10)
	}
	return { frames, final: harness.lastFrame() ?? '' }
}

describe('a streamed reply', () => {
	it('never shows a half-written word', async () => {
		const { frames } = await runTurnCapturing()
		// The prefixes a per-token append would have put on screen. A frame that
		// carries one WITHOUT the rest of its word shows the word as it is typed.
		for (const frame of frames) {
			if (frame.includes('First parag')) {
				expect(frame, 'a partial word was rendered').toContain('First paragraph')
			}
			if (frame.includes('the tai')) {
				expect(frame, 'a partial word was rendered').toContain('the tail')
			}
		}
	})

	it('shows the first paragraph, printed, before the reply has finished', async () => {
		// A finished block is printed at once: it is on screen while the rest of
		// the reply has not arrived.
		holdAfter = 'First paragraph here.\n\n'
		const { frames } = await runTurnCapturing('the tail.', 'First paragraph here.')
		const partway = frames.filter(
			(f) => f.includes('First paragraph here.') && !f.includes('Second'),
		)
		expect(partway.length, 'the first block was never shown on its own').toBeGreaterThan(0)
	})

	it('loses nothing — the trailing block reaches the screen', async () => {
		// The failure this file exists for. The tail of a reply is an incomplete
		// block by construction, so it only ever arrives via the flush on the
		// close path. Delete that flush and every answer loses its last
		// paragraph, silently, on a turn that otherwise looks fine.
		const { final } = await runTurnCapturing()
		expect(final).toContain('First paragraph here.')
		expect(final).toContain('Second paragraph, the tail.')
	})

	it('shows a reply that never completes a block at all', async () => {
		// The common case: a short answer with no blank line in it, so NO block
		// ever completes and the whole reply lives in the buffer until the turn
		// ends. If the flush cannot create the bubble that no released block
		// ever made, this loses the entire answer rather than a paragraph of it
		// — and the turn still looks like it succeeded.
		reply = ONE_BLOCK
		const { final } = await runTurnCapturing('anywhere in it.')
		expect(final).toContain(ONE_BLOCK)
	})

	it('shows each block exactly once', async () => {
		// A released block that is not drained from the buffer is appended
		// again on the next release, so the reply grows copies of its own
		// opening. Every assertion above is `toContain`, and every one of them
		// passes on a duplicated transcript.
		const { final } = await runTurnCapturing()
		const occurrences = final.split('First paragraph here.').length - 1
		expect(occurrences, 'the first block was rendered more than once').toBe(1)
	})
})

it('separates a completion follow-up from the earlier status answer without dropping either tail', async () => {
	separateMessages = true
	const { final } = await runTurnCapturing('CLI review completed.')
	expect(final).toContain('CLI review is running.')
	expect(final).toContain('CLI review completed.')
	expect(final).not.toContain('running.CLI')
	expect(final.match(/∴/g)).toHaveLength(2)
})
