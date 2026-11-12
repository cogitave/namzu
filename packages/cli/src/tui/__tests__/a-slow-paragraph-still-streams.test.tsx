/**
 * A paragraph that takes a while is shown as it is written.
 *
 * A model's paragraph is ONE line, and a long one arriving over twenty seconds
 * must not be a blank row for twenty seconds: the operator reads that as "it
 * stopped". These stream a single paragraph and assert that its first sentence
 * is on screen before the reply ends, while never showing a half-written word.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
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
/** Per-character delay while the head streams; it only paces the stream, no outcome depends on it. */
const DELAY_MS = 15
/** The reply up to the end of the second sentence. The tail is held back until a test releases it. */
const HEAD = `${SENTENCES[0]} ${SENTENCES[1]}`
const TAIL = SLOW_PARAGRAPH.slice(HEAD.length)

/**
 * The tail of the reply waits on this gate, so "the first sentence is on
 * screen while the paragraph is unfinished" is a state the test holds the
 * stream in, rather than a window it has to catch before a real clock closes it.
 */
const gate = vi.hoisted(() => ({ open: () => {} }))

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
				const tailMayFollow = new Promise<void>((resolve) => {
					gate.open = resolve
				})
				for (const ch of HEAD) {
					yield { kind: 'delta', text: ch } as AgentEvent
					await new Promise((r) => setTimeout(r, DELAY_MS))
				}
				await tailMayFollow
				for (const ch of TAIL) {
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

/**
 * Poll until the frame shows the needle. There is no deadline: a frame that
 * never shows it is a hang, which the test's own timeout reports.
 */
async function frameShows(read: () => string | undefined, needle: string) {
	while (!(read() ?? '').includes(needle)) await tick(20)
}

/**
 * Run the turn, releasing the held tail once the first sentence is on screen.
 * `heldFrame` is the frame the stream was held in at that moment.
 */
async function runTurnCapturing(): Promise<{
	frames: string[]
	final: string
	heldFrame: string
}> {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')

	const frames: string[] = []
	let heldFrame = ''
	let released = false
	for (;;) {
		const f = harness.lastFrame() ?? ''
		if (frames[frames.length - 1] !== f) frames.push(f)
		if (!released && f.includes(SENTENCES[0] as string)) {
			released = true
			heldFrame = f
			gate.open()
		}
		if (f.includes('is the tail.')) break
		await tick(10)
	}
	return { frames, final: harness.lastFrame() ?? '', heldFrame }
}

describe('a slow single-paragraph reply', () => {
	it('shows its first sentence before the paragraph has finished', async () => {
		const { heldFrame } = await runTurnCapturing()
		// The tail had not been sent when this frame was read, so the paragraph was unfinished.
		expect(heldFrame, 'the first sentence was never shown on its own').toContain(
			'The first sentence lands early.',
		)
		expect(heldFrame).not.toContain('is the tail.')
	})

	it('still never shows a half-written word', async () => {
		const { frames } = await runTurnCapturing()
		for (const frame of frames) {
			if (frame.includes('The first sen')) {
				expect(frame, 'a partial word was rendered').toContain('The first sentence')
			}
			if (frame.includes('Then a pau')) {
				expect(frame, 'a partial word was rendered').toContain('Then a pause')
			}
		}
	})

	it('loses nothing and duplicates nothing', async () => {
		const { final } = await runTurnCapturing()
		expect(final).toContain(SLOW_PARAGRAPH)
		expect(final.split('The first sentence lands early.').length - 1).toBe(1)
	})
})
