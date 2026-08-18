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
const persisted: Message[][] = []
const sentOptions: SendOptions[] = []
const evidenceStarts: Array<{
	readonly turnId: string
	readonly runId: string
	readonly displayText: string
	readonly user: Message
}> = []
const evidenceSettlements: Array<{
	readonly turnId: string
	readonly runId: string
	readonly outcome: string
	readonly assistantText: string
}> = []
const sendSawDurableBinding: boolean[] = []
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
	openSessions: async () => ({
		tenantId: 't',
		turnEvidence: {
			recordTurnStarted: async (input: {
				runId: string
				displayText: string
				user: Message
			}) => {
				const record = {
					turnId: `turn_${evidenceStarts.length + 1}`,
					runId: input.runId,
					displayText: input.displayText,
					user: input.user,
				}
				evidenceStarts.push(record)
				return record
			},
			recordTurnSettled: async (input: {
				turnId: string
				runId: string
				outcome: string
				assistantText: string
			}) => {
				evidenceSettlements.push(input)
				return input
			},
		},
	}),
	startConversation: async () => 'conv',
	appendMessages: async (_sessions: unknown, _id: string, messages: readonly Message[]) => {
		persisted.push([...messages])
	},
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
			// The TUI never resumes a durable run; a stub that answered would
			// make a resume look reachable from here.
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (messages, options): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				sentOptions.push(options ?? {})
				sendSawDurableBinding.push(
					typeof options?.runId === 'string' &&
						evidenceStarts.some((record) => record.runId === options.runId),
				)
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
	timeoutMs = 3_000,
): Promise<void> {
	const started = performance.now()
	while (!(lastFrame() ?? '').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

beforeEach(() => {
	clipboard = { kind: 'empty' }
	sent.length = 0
	persisted.length = 0
	sentOptions.length = 0
	evidenceStarts.length = 0
	evidenceSettlements.length = 0
	sendSawDurableBinding.length = 0
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

async function sendsReach(count: number, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (sent.length < count && performance.now() - started < timeoutMs) await tick(20)
}

async function persistenceReaches(count: number, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (persisted.length < count && performance.now() - started < timeoutMs) await tick(20)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
}

describe('Ctrl+V with nothing to paste', () => {
	it('keeps SDK cancellation distinct in durable turn evidence', async () => {
		nextStopReason = 'cancelled'
		const harness = await ready()

		await submit(harness, 'cancel this turn')
		await persistenceReaches(1)

		expect(evidenceSettlements).toMatchObject([{ outcome: 'cancelled' }])
	})

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
		await frameShows(harness.lastFrame, '1 message queued')

		clipboard = { kind: 'image', image: secondImage }
		harness.stdin.write('\x16')
		await frameShows(harness.lastFrame, 'Image #1')
		await submit(harness, 'queued second')
		await frameShows(harness.lastFrame, '2 messages queued')

		firstGate?.release()
		await sendsReach(3)
		await persistenceReaches(3)

		const sentTurns = sent.slice(1).map((history) => history.at(-1))
		expect(
			sentTurns.map((message) => message?.content),
			'a later prompt bypassed the queue or an older snapshot erased it',
		).toEqual(['queued first', 'queued second'])
		expect(
			sentTurns.map((message) => (message?.role === 'user' ? message.attachments : undefined)),
			'the queue preserved text but discarded the composer attachment',
		).toEqual([[firstImage], [secondImage]])

		const durableTurns = persisted.slice(1).map((turn) => turn[0])
		expect(durableTurns.map((message) => message?.content)).toEqual(['queued first', 'queued second'])
		expect(
			durableTurns.map((message) =>
				message?.role === 'user' ? message.attachments : undefined,
			),
			'the provider saw an attachment that /resume and /fork would lose',
		).toEqual([[firstImage], [secondImage]])

		expect(sendSawDurableBinding).toEqual([true, true, true])
		expect(new Set(sentOptions.map((options) => options.runId)).size).toBe(3)
		expect(
			evidenceStarts.slice(1).map((record) => ({
				displayText: record.displayText,
				content: record.user.content,
				attachments: record.user.role === 'user' ? record.user.attachments : undefined,
			})),
			'turn evidence was reduced to display text or recorded after the provider started',
		).toEqual([
			{ displayText: 'queued first', content: 'queued first', attachments: [firstImage] },
			{ displayText: 'queued second', content: 'queued second', attachments: [secondImage] },
		])
		expect(evidenceSettlements.map((record) => record.runId)).toEqual(
			sentOptions.map((options) => options.runId),
		)
	})
})
