/**
 * Ctrl+V reports its outcome, including the outcomes that are not an image.
 *
 * The status bar advertises `Ctrl+V to attach`. The handler read the clipboard,
 * attached an image if it found one, and otherwise did nothing at all — no
 * chip, no message, no error. So "you have not copied an image", "this machine
 * has no clipboard tool installed", and "this key was never wired up" were the
 * same observable event, and the operator's next move is different in each.
 *
 * These drive a rendered `<App>` rather than the component alone. The composer
 * has no transcript of its own, so whether a clipboard refusal reaches the
 * screen depends on App. More importantly, App owns the between-turn queue:
 * only a complete provider history and durable append can prove that a chip
 * submitted during another turn did not become text-only at that boundary.
 */

import type { Message, StopReason } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** What the mocked clipboard returns for the next read. */
let clipboard: import('../../integrations/clipboard/image.js').ClipboardRead = { kind: 'empty' }
const sent: Message[][] = []
const sentOptions: SendOptions[] = []
let nextStopReason: StopReason = 'end_turn'

/** A gate per provider turn, when a test needs to observe the queue between turns. */
const turnGates: Array<{ wait: Promise<void>; release: () => void }> = []
function holdNextTurn(): void {
	let release: () => void = () => {}
	const wait = new Promise<void>((resolve) => {
		release = resolve
	})
	turnGates.push({ wait, release })
}

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => clipboard,
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
			approvalLatched: () => false,
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

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

async function frameShows(
	lastFrame: () => string | undefined,
	text: string,
	timeoutMs?: number,
): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').toContain(text), timeoutMs)
}

beforeEach(() => {
	clipboard = { kind: 'empty' }
	sent.length = 0
	sentOptions.length = 0
	nextStopReason = 'end_turn'
	for (const gate of turnGates.splice(0)) gate.release()
})

afterEach(() => {
	for (const gate of turnGates.splice(0)) gate.release()
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function ready() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	return harness
}

async function sendsReach(count: number, timeoutMs?: number): Promise<void> {
	await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(count), timeoutMs)
}


async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
}

describe('Ctrl+V with nothing to paste', () => {
	it('says the clipboard holds no image, rather than doing nothing', async () => {
		clipboard = { kind: 'empty' }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16') // Ctrl+V
		await frameShows(lastFrame, 'No image on the clipboard')

		expect(lastFrame(), 'the key was silent').toContain('No image on the clipboard')
	})

	it('names what is missing when the machine cannot read the clipboard at all', async () => {
		// A different situation with a different fix, so it gets a different
		// sentence: nothing the operator copies will help until a tool exists.
		clipboard = { kind: 'unavailable', detail: 'install xclip (X11) or wl-clipboard (Wayland)' }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16')
		await frameShows(lastFrame, 'Cannot read images')

		const frame = lastFrame() ?? ''
		expect(frame).toContain('Cannot read images')
		expect(frame, 'did not say what to install').toContain('xclip')
		expect(frame, 'blamed an empty clipboard for a missing tool').not.toContain(
			'No image on the clipboard',
		)
	})
})

describe('Ctrl+V with an image', () => {
	it('attaches it and says nothing, because the chip is the report', async () => {
		clipboard = { kind: 'image', image: { data: 'AAAA', mediaType: 'image/png' } }
		const { stdin, lastFrame } = await ready()

		stdin.write('\x16')
		await frameShows(lastFrame, 'Image #1')

		const frame = lastFrame() ?? ''
		expect(frame).toContain('Image #1')
		expect(frame, 'reported a failure on the success path').not.toContain('No image')
	})

	it('keeps the attachment in model history after its composer chip is gone', async () => {
		const image = { data: 'AAAA', mediaType: 'image/png' as const }
		clipboard = { kind: 'image', image }
		const harness = await ready()

		harness.stdin.write('\x16')
		await frameShows(harness.lastFrame, 'Image #1')
		await submit(harness, 'inspect this image')
		await sendsReach(1)
		await frameShows(harness.lastFrame, 'Type a message')
		await submit(harness, 'what did it show?')
		await sendsReach(2)

		expect(sent).toHaveLength(2)
		const preserved = sent[1]?.[0]
		expect(preserved?.role).toBe('user')
		expect(
			preserved?.role === 'user' ? preserved.attachments : undefined,
			'the next request rebuilt history from the attachment-free transcript row',
		).toEqual([image])
	})

	it('keeps queued images attached, in FIFO order, through the provider and durable turn', async () => {
		const firstImage = { data: 'FIRST', mediaType: 'image/png' as const }
		const secondImage = { data: 'SECOND', mediaType: 'image/png' as const }
		holdNextTurn()
		const firstGate = turnGates[0]
		const harness = await ready()

		await submit(harness, 'turn already running')
		await sendsReach(1)

		clipboard = { kind: 'image', image: firstImage }
		harness.stdin.write('\x16')
		await frameShows(harness.lastFrame, 'Image #1')
		await submit(harness, 'queued first')
		await frameShows(harness.lastFrame, '1 message steering the active turn')

		clipboard = { kind: 'image', image: secondImage }
		harness.stdin.write('\x16')
		await frameShows(harness.lastFrame, 'Image #1')
		await submit(harness, 'queued second')
		await frameShows(harness.lastFrame, '2 messages steering the active turn')

		firstGate?.release()
		await sendsReach(3)

		const sentTurns = sent.slice(1).map((history) => history.at(-1))
		expect(
			sentTurns.map((message) => message?.content),
			'a later prompt bypassed the queue or an older snapshot erased it',
		).toEqual(['queued first', 'queued second'])
		expect(
			sentTurns.map((message) => (message?.role === 'user' ? message.attachments : undefined)),
			'the queue preserved text but discarded the composer attachment',
		).toEqual([[firstImage], [secondImage]])

		// Each turn is its own: a reserved id, a prompt origin, and the exact
		// user message (attachments included) the kernel records in the log.
		expect(sentOptions.every((options) => typeof options.turnId === 'string')).toBe(true)
		expect(new Set(sentOptions.map((options) => options.turnId)).size).toBe(3)
		expect(sentOptions.map((options) => options.origin)).toEqual([
			{ protocol: 'cli', kind: 'prompt' },
			{ protocol: 'cli', kind: 'prompt' },
			{ protocol: 'cli', kind: 'prompt' },
		])
	})
})
