/**
 * A reply lands in whole blocks, and none of it is lost.
 *
 * Deltas used to be appended the moment they arrived, so a reply typed itself
 * onto the screen a few characters at a time. Nothing animated it — there is
 * no timer anywhere in this package — but the effect is the same, and an
 * operator ends up watching a line grow instead of reading it.
 *
 * Holding output back is cheap to get wrong in the one direction that matters.
 * The tail of a reply is almost always an incomplete block, so a close path
 * that forgets to flush drops the last paragraph of nearly every answer — and
 * it drops it *silently*, on the exit path, where the turn otherwise looks
 * successful. `splitCompleteBlocks` is unit-tested next door and cannot catch
 * that: it is a pure function that never sees a turn end.
 *
 * So these drive a rendered `<App>` through a real turn. The claim is about
 * what is on the screen, which is the only thing that can establish it.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
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

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
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
				// One character per event: the shape that produced the typing
				// effect, and the shape that catches a splitter that releases a
				// partial word.
				for (const ch of reply) {
					yield { kind: 'delta', text: ch } as AgentEvent
					await new Promise((r) => setTimeout(r, 0))
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
async function runTurnCapturing(until = 'the tail.'): Promise<{ frames: string[]; final: string }> {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')

	const frames: string[] = []
	const deadline = Date.now() + 4000
	while (Date.now() < deadline) {
		const f = harness.lastFrame() ?? ''
		if (frames[frames.length - 1] !== f) frames.push(f)
		if (f.includes(until)) break
		await tick(10)
	}
	return { frames, final: harness.lastFrame() ?? '' }
}

describe('a streamed reply', () => {
	it('never shows a half-written word', async () => {
		const { frames } = await runTurnCapturing()
		// The prefixes a per-token append would have put on screen. If any frame
		// carries one WITHOUT the rest of its word, the reveal is still
		// character-by-character.
		for (const frame of frames) {
			if (frame.includes('First parag')) {
				expect(frame, 'a partial word was rendered').toContain('First paragraph here.')
			}
			if (frame.includes('the tai')) {
				expect(frame, 'a partial word was rendered').toContain('the tail.')
			}
		}
	})

	it('shows the first paragraph before the reply has finished', async () => {
		// The other direction. Holding EVERYTHING back until the turn ends is a
		// different product decision, and this pins the one that was chosen: a
		// completed block is released while the rest is still arriving.
		const { frames } = await runTurnCapturing()
		const partway = frames.filter((f) => f.includes('First paragraph here.') && !f.includes('the tail.'))
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
