/**
 * Manual compaction has to change the conversation the NEXT turn receives.
 *
 * A transcript notice is not compaction. The first implementation placed the
 * summary in a `system` row for the operator, then rebuilt provider history by
 * filtering the transcript to user/assistant rows. The screen said the old
 * turns had been summarized while the next request received neither those
 * turns nor their summary.
 *
 * This is driven through `<App>` because `compactNow` already returns the
 * right messages; the defect is reachability from that result to the next
 * `session.send` and to conversation persistence.
 */

import { createSystemMessage, type Message } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const SUMMARY_TEXT = 'SUMMARY_ONLY_FROM_COMPACTION'
const PERSISTED_SUMMARY_TEXT =
	'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.\n\nSUMMARY_LOADED_FROM_DISK'
const sent: Message[][] = []
const replacements: Message[][] = []
const appended: Message[][] = []
let mentionExpansion: { readonly sendText: string; readonly attached: readonly string[] } | null = null
let loadedConversation: Message[] = []
let recentConversations: Array<{
	id: string
	title: string
	updatedAt: string
	count: number
}> = []
let compactCalls = 0
let appendCalls = 0
let replaceShouldFail = false
let holdAppend = false
let appendWait: Promise<void> = Promise.resolve()
let releaseAppend: () => void = () => {}
let turnWait: Promise<void> | null = null
let releaseTurn: () => void = () => {}

function resetAppendGate(): void {
	appendWait = new Promise<void>((resolve) => {
		releaseAppend = resolve
	})
}

function holdTurn(): void {
	turnWait = new Promise<void>((resolve) => {
		releaseTurn = resolve
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	appendMessages: async (_s: unknown, _id: string, messages: readonly Message[]) => {
		appendCalls += 1
		appended.push([...messages])
		if (holdAppend) await appendWait
	},
	replaceConversation: async (_s: unknown, _id: string, messages: readonly Message[]) => {
		if (replaceShouldFail) throw new Error('REPLACEMENT_DID_NOT_LAND')
		replacements.push([...messages])
	},
	listRecent: async () => recentConversations,
	loadConversation: async () => loadedConversation,
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../mentions.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../mentions.js')>()
	return {
		...actual,
		expandFileMentions: (text: string, cwd: string) =>
			mentionExpansion ?? actual.expandFileMentions(text, cwd),
	}
})

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
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
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async (messages) => {
				compactCalls += 1
				const summary = createSystemMessage(SUMMARY_TEXT)
				return { messages: [summary, ...messages.slice(-2)], shed: 1, summary }
			},
			send: async function* (messages): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				yield { kind: 'delta', text: `answer-${sent.length}` } as AgentEvent
				if (turnWait) await turnWait
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	sent.length = 0
	replacements.length = 0
	appended.length = 0
	mentionExpansion = null
	loadedConversation = []
	recentConversations = []
	compactCalls = 0
	appendCalls = 0
	replaceShouldFail = false
	holdAppend = false
	resetAppendGate()
	turnWait = null
	releaseTurn = () => {}
})

afterEach(() => {
	releaseAppend()
	releaseTurn()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function frameShows(
	harness: { readonly frames: readonly string[] },
	text: string,
	timeoutMs = 5_000,
): Promise<void> {
	const started = performance.now()
	while (!harness.frames.join('\n').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
	expect(harness.frames.join('\n')).toContain(text)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!predicate() && performance.now() - started < timeoutMs) await tick(20)
}

it('puts the compacted summary in the next model request and the durable conversation', async () => {
	holdAppend = true
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, 'Connected to a-provider')

	await submit(harness, 'first question')
	await frameShows(harness, 'answer-1')
	await waitUntil(() => appendCalls === 1)
	await submit(harness, '/compact')
	await tick(80)
	expect(replacements, 'compaction overtook the turn still being appended').toHaveLength(0)
	await submit(harness, 'input while the compaction snapshot is owned')
	expect(sent, 'input started a turn while compaction owned the history snapshot').toHaveLength(1)
	releaseAppend()
	await frameShows(harness, 'Compacted')
	await tick(80)
	expect(sent, 'input queued while compaction owned the history snapshot').toHaveLength(1)

	expect(replacements, 'the durable conversation was not compacted').toHaveLength(1)
	expect(replacements[0]?.some((message) => message.content === SUMMARY_TEXT)).toBe(true)

	await submit(harness, 'question after compaction')
	await frameShows(harness, 'answer-2')

	expect(sent, 'the second turn never ran').toHaveLength(2)
	expect(
		sent[1]?.some((message) => message.role === 'system' && message.content === SUMMARY_TEXT),
		'the compaction summary never reached the next model request',
	).toBe(true)
})

it('restores a persisted compaction summary as model history', async () => {
	loadedConversation = [
		createSystemMessage(PERSISTED_SUMMARY_TEXT),
		{ role: 'user', content: 'recent question', timestamp: 1 },
		{ role: 'assistant', content: 'recent answer', timestamp: 2 },
	]
	recentConversations = [
		{
			id: 'conv-compacted',
			title: 'A compacted conversation',
			updatedAt: new Date().toISOString(),
			count: loadedConversation.length,
		},
	]
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, 'Connected to a-provider')

	await submit(harness, '/resume')
	await frameShows(harness, 'Resume a conversation')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: A compacted conversation')
	await frameShows(harness, 'Earlier turns are represented by the compacted summary below.')

	await submit(harness, 'question after resume')
	await frameShows(harness, 'answer-1')

	expect(sent).toHaveLength(1)
	expect(
		sent[0]?.some(
			(message) => message.role === 'system' && message.content === PERSISTED_SUMMARY_TEXT,
		),
		'the summary loaded from disk was discarded before the next model request',
	).toBe(true)
})

it('keeps the live history unchanged when its durable replacement fails', async () => {
	replaceShouldFail = true
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, 'Connected to a-provider')

	await submit(harness, 'question before failed compaction')
	await frameShows(harness, 'answer-1')
	await submit(harness, '/compact')
	await frameShows(harness, 'Compaction failed: REPLACEMENT_DID_NOT_LAND')

	await submit(harness, 'question after failed compaction')
	await frameShows(harness, 'answer-2')
	expect(
		sent[1]?.some((message) => message.content === SUMMARY_TEXT),
		'the live history changed even though its durable replacement did not land',
	).toBe(false)
})

it('persists and reuses the model-visible form of a file mention', async () => {
	const expanded = 'inspect @note.txt\n\n<file path="note.txt">\nBODY_ONLY_IN_MODEL_HISTORY\n</file>'
	mentionExpansion = { sendText: expanded, attached: ['note.txt'] }
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, 'Connected to a-provider')

	await submit(harness, 'inspect @note.txt')
	await frameShows(harness, 'answer-1')
	await waitUntil(() => appended.length === 1)
	mentionExpansion = null
	await submit(harness, 'follow-up')
	await frameShows(harness, 'answer-2')

	expect(appended[0]?.[0]?.content, 'disk history kept only the readable transcript token').toBe(
		expanded,
	)
	expect(sent[1]?.[0]?.content, 'the next request rebuilt the user turn from the transcript').toBe(
		expanded,
	)
})

it('refuses to compact a turn that is still producing its next message', async () => {
	holdTurn()
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, 'Connected to a-provider')

	await submit(harness, 'a running question')
	await waitUntil(() => sent.length === 1)
	await submit(harness, '/compact')
	await tick(80)

	expect(compactCalls, 'the running conversation was summarized from an incomplete snapshot').toBe(0)
	await frameShows(harness, 'A turn is still running')
})
