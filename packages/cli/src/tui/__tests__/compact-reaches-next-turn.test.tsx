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

import { createSystemMessage, type Message, type RunId } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

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
let compactReturnsNull = false
let appendCalls = 0
let replaceShouldFail = false
let holdReplacement = false
let replaceEntered = 0
let replacementWait: Promise<void> = Promise.resolve()
let releaseReplacement: () => void = () => {}
let rejectReplacement: (reason?: unknown) => void = () => {}
let holdAppend = false
let appendWait: Promise<void> = Promise.resolve()
let releaseAppend: () => void = () => {}
let turnWait: Promise<void> | null = null
let releaseTurn: () => void = () => {}
let reportContextUsage = false
let reportAutomaticCompaction = false
let automaticFailureWait: Promise<void> = Promise.resolve()
let releaseAutomaticFailure: () => void = () => {}

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
let compactionUsage = ZERO_USAGE

function resetAppendGate(): void {
	appendWait = new Promise<void>((resolve) => {
		releaseAppend = resolve
	})
}

function resetReplacementGate(): void {
	replacementWait = new Promise<void>((resolve, reject) => {
		releaseReplacement = resolve
		rejectReplacement = reject
	})
}

function holdTurn(): void {
	turnWait = new Promise<void>((resolve) => {
		releaseTurn = resolve
	})
}

function holdAutomaticFailure(): void {
	automaticFailureWait = new Promise<void>((resolve) => {
		releaseAutomaticFailure = resolve
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async (_s: unknown, _id: string, messages: readonly Message[]) => {
		appendCalls += 1
		appended.push([...messages])
		if (holdAppend) await appendWait
	},
	replaceConversation: async (_s: unknown, _id: string, messages: readonly Message[]) => {
		replaceEntered += 1
		if (holdReplacement) await replacementWait
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
				if (compactReturnsNull) return null
				// The SDK pins host-triggered summaries because no run-scoped
				// WorkingStateManager exists between turns to reproduce them.
				const summary = { ...createSystemMessage(SUMMARY_TEXT), retain: true }
				return {
					messages: [summary, ...messages.slice(-2)],
					shed: 1,
					summary,
					usage: compactionUsage,
				}
			},
			send: async function* (messages): AsyncIterable<AgentEvent> {
				sent.push([...messages])
				if (reportAutomaticCompaction && sent.length === 2) {
					// Use the production RunEvent -> AgentEvent mapper. The App-level
					// observer below therefore covers both hops that must remain intact:
					// SDK status snapshot mapping and StatusBar publication.
					yield actual.toAgentEvent(
						{
							type: 'compaction_completed',
							runId: 'run_auto_compaction' as RunId,
							iteration: 2,
							messagesBefore: 40,
							messagesAfter: 6,
							tokensBefore: 95_000,
							tokensAfter: 20_000,
							measuredBy: 'provider',
							contextWindowTokens: 100_000,
							windowSource: 'provider',
						},
						{} as never,
					) as AgentEvent
					yield actual.toAgentEvent(
						{
							type: 'token_usage_updated',
							runId: 'run_auto_compaction' as RunId,
							usage: { ...ZERO_USAGE, totalTokens: 9_500 },
							cost: { totalCost: 0.19, cacheDiscount: 0, unpricedTokens: 0 },
							contextTokens: 20_000,
							contextMeasuredBy: 'estimate',
							contextWindowTokens: 100_000,
							windowSource: 'provider',
						},
						{} as never,
					) as AgentEvent
					await automaticFailureWait
					yield {
						kind: 'error',
						message: 'NEXT_PROVIDER_FAILED',
					} as AgentEvent
					return
				}
				yield { kind: 'delta', text: `answer-${sent.length}` } as AgentEvent
				if (reportContextUsage) {
					yield {
						kind: 'usage',
						totalTokens: 9_500,
						cost: { totalCost: 0.19, cacheDiscount: 0, unpricedTokens: 0 },
						contextTokens: 95_000,
						contextMeasuredBy: 'provider',
						contextWindowTokens: 100_000,
						windowSource: 'provider',
					} as AgentEvent
				}
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
const mountedScreens: Screen[] = []

beforeEach(() => {
	sent.length = 0
	replacements.length = 0
	appended.length = 0
	mentionExpansion = null
	loadedConversation = []
	recentConversations = []
	compactCalls = 0
	compactReturnsNull = false
	appendCalls = 0
	replaceShouldFail = false
	holdReplacement = false
	replaceEntered = 0
	resetReplacementGate()
	holdAppend = false
	resetAppendGate()
	turnWait = null
	releaseTurn = () => {}
	reportContextUsage = false
	reportAutomaticCompaction = false
	automaticFailureWait = Promise.resolve()
	releaseAutomaticFailure = () => {}
	compactionUsage = ZERO_USAGE
})

afterEach(async () => {
	releaseAppend()
	releaseReplacement()
	releaseTurn()
	releaseAutomaticFailure()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	for (const screen of mountedScreens) await screen.unmount()
	mountedScreens.length = 0
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

async function waitForScreen(
	screen: Screen,
	predicate: () => boolean,
	attempts = 120,
): Promise<void> {
	for (let i = 0; i < attempts && !predicate(); i++) await screen.waitForRender()
	expect(predicate()).toBe(true)
}

async function submitToScreen(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

function visibleScreen(screen: Screen): string {
	return screen.viewport().join('\n')
}

function fullScreen(screen: Screen): string {
	return screen.scrollback().join('\n')
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
	expect(replacements[0]?.find((message) => message.content === SUMMARY_TEXT)?.retain).toBe(true)

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

it('publishes the summary only after durable compaction settles without footer telemetry', async () => {
	reportContextUsage = true
	holdReplacement = true
	compactionUsage = {
		promptTokens: 1_200,
		completionTokens: 34,
		totalTokens: 1_234,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 180, rows: 40 })
	mountedScreens.push(screen)
	await waitForScreen(screen, () => fullScreen(screen).includes('Connected to a-provider'))

	await submitToScreen(screen, 'question before durable compaction')
	await waitForScreen(screen, () => fullScreen(screen).includes('answer-1'))
	expect(visibleScreen(screen)).not.toContain('95%')

	await submitToScreen(screen, '/compact')
	await waitForScreen(screen, () => replaceEntered === 1)
	expect(visibleScreen(screen)).not.toContain('95%')
	expect(fullScreen(screen)).toContain('question before durable compaction')
	expect(fullScreen(screen)).toContain('answer-1')
	expect(fullScreen(screen)).not.toContain('Compacted 1 earlier message')

	releaseReplacement()
	await waitForScreen(screen, () => fullScreen(screen).includes('Compacted 1 earlier message'))
	expect(fullScreen(screen)).toContain('Verifier used 1,234 tokens.')
	expect(visibleScreen(screen)).not.toContain('95%')
})

it('keeps footer telemetry quiet while a durable replacement is pending or rejected', async () => {
	reportContextUsage = true
	holdReplacement = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 180, rows: 40 })
	mountedScreens.push(screen)
	await waitForScreen(screen, () => fullScreen(screen).includes('Connected to a-provider'))

	await submitToScreen(screen, 'question before rejected compaction')
	await waitForScreen(screen, () => fullScreen(screen).includes('answer-1'))
	await submitToScreen(screen, '/compact')
	await waitForScreen(screen, () => replaceEntered === 1)
	expect(visibleScreen(screen)).not.toContain('95%')
	expect(fullScreen(screen)).not.toContain('Compacted 1 earlier message')

	rejectReplacement(new Error('REPLACEMENT_DID_NOT_LAND'))
	await waitForScreen(screen, () => fullScreen(screen).includes('REPLACEMENT_DID_NOT_LAND'))
	expect(visibleScreen(screen)).not.toContain('95%')
	expect(fullScreen(screen)).toContain('question before rejected compaction')
	expect(fullScreen(screen)).not.toContain('Compacted 1 earlier message')
})

it('keeps footer telemetry quiet when compaction has nothing to replace', async () => {
	reportContextUsage = true
	compactReturnsNull = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 180, rows: 40 })
	mountedScreens.push(screen)
	await waitForScreen(screen, () => fullScreen(screen).includes('Connected to a-provider'))

	await submitToScreen(screen, 'short conversation')
	await waitForScreen(screen, () => fullScreen(screen).includes('answer-1'))
	await submitToScreen(screen, '/compact')
	await waitForScreen(screen, () => fullScreen(screen).includes('adding a summary would save no messages'))

	expect(visibleScreen(screen)).not.toContain('95%')
	expect(replaceEntered).toBe(0)
	expect(fullScreen(screen)).not.toContain('Compacted 1 earlier message')
})

it('shows automatic compaction before the next provider settles without footer telemetry', async () => {
	reportContextUsage = true
	reportAutomaticCompaction = true
	holdAutomaticFailure()
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 180,
		rows: 40,
	})
	mountedScreens.push(screen)
	await waitForScreen(screen, () => fullScreen(screen).includes('Connected to a-provider'))

	await submitToScreen(screen, 'fill the context')
	await waitForScreen(screen, () => fullScreen(screen).includes('answer-1'))
	await submitToScreen(screen, 'continue after automatic compaction')
	await waitForScreen(screen, () => fullScreen(screen).includes('context compacted'))

	expect(fullScreen(screen)).not.toContain('NEXT_PROVIDER_FAILED')
	expect(visibleScreen(screen)).not.toContain('95%')
	expect(visibleScreen(screen)).not.toContain('~20%')

	releaseAutomaticFailure()
	await waitForScreen(screen, () => fullScreen(screen).includes('NEXT_PROVIDER_FAILED'))
	expect(visibleScreen(screen)).not.toContain('~20%')
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
