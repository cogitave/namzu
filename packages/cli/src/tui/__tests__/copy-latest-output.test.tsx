/**
 * `/copy` is about a completion boundary, not whatever text is visible now.
 *
 * A streaming row already contains raw model text, but reading it would copy a
 * half-answer while a turn runs. Persistence has raw text too, but a failed or
 * cancelled turn can persist a partial assistant message. These tests drive the
 * rendered App so the command, stream boundary, conversation switch and
 * clipboard adapter have to agree end to end.
 */

import { createAssistantMessage, createUserMessage, type Message, type StopReason } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClipboardWriteResult } from '../../integrations/clipboard/text.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

type TurnScript = {
	readonly text: string
	readonly stopReason?: StopReason
	readonly hold?: boolean
}

const requested: string[] = []
let clipboardResult: ClipboardWriteResult = { kind: 'request-sent', bytes: 0 }
let turns: TurnScript[] = []
let sendCalls = 0
let releaseHeldTurn: () => void = () => {}
let heldTurn: Promise<void> = Promise.resolve()
let recentConversations: Array<{ id: string; title: string; updatedAt: string; count: number }> = []
let loadedConversation: Message[] = []

function resetHeldTurn(): void {
	heldTurn = new Promise<void>((resolve) => {
		releaseHeldTurn = resolve
	})
}

vi.mock('../../integrations/clipboard/text.js', () => ({
	writeClipboardText: (text: string) => {
		requested.push(text)
		return clipboardResult.kind === 'request-sent'
			? { ...clipboardResult, bytes: Buffer.byteLength(text, 'utf8') }
			: clipboardResult
	},
}))
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => recentConversations,
	loadConversation: async () => loadedConversation,
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
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			send: async function* (): AsyncIterable<AgentEvent> {
				const script = turns[sendCalls]
				sendCalls += 1
				if (!script) throw new Error(`No turn script at index ${sendCalls - 1}`)
				yield { kind: 'delta', text: script.text } as AgentEvent
				if (script.hold) await heldTurn
				yield {
					kind: 'done',
					...(script.stopReason ? { stopReason: script.stopReason } : {}),
				} as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	requested.length = 0
	clipboardResult = { kind: 'request-sent', bytes: 0 }
	turns = []
	sendCalls = 0
	recentConversations = []
	loadedConversation = []
	resetHeldTurn()
})

afterEach(() => {
	releaseHeldTurn()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function frameShows(
	harness: { readonly frames: readonly string[] },
	text: string,
	timeoutMs = 3_000,
): Promise<void> {
	const normalizedExpected = text.replace(/\s+/g, ' ')
	const started = performance.now()
	while (
		!harness.frames.join('\n').replace(/\s+/g, ' ').includes(normalizedExpected) &&
		performance.now() - started < timeoutMs
	) {
		await tick(20)
	}
	expect(harness.frames.join('\n').replace(/\s+/g, ' ')).toContain(normalizedExpected)
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!predicate() && performance.now() - started < timeoutMs) await tick(20)
	expect(predicate()).toBe(true)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

async function openCopyPicker(harness: {
	readonly frames: readonly string[]
	stdin: { write: (value: string) => void }
}) {
	await submit(harness, '/copy')
	await frameShows(harness, 'Copy from response')
}

async function chooseWholeResponse(harness: {
	readonly frames: readonly string[]
	stdin: { write: (value: string) => void }
}) {
	await openCopyPicker(harness)
	harness.stdin.write('\r')
}

async function mountReady() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	// The probing screen also says "Type a message to begin", while its
	// composer is disabled and drops every key. Wait for text only the live
	// composer can render, or the test exercises silence before the feature is
	// reachable and reports it as a command failure.
	await frameShows(harness, '> Type a message… (/help for commands)')
	return harness
}

it('refuses before the first normally completed assistant output', async () => {
	const harness = await mountReady()

	await submit(harness, '/copy')
	await frameShows(harness, 'Nothing to copy yet')

	expect(requested).toEqual([])
})

it('sends the exact raw Markdown and keeps it after /clear-screen', async () => {
	const raw = '# Result\n\n**bold** and `code`\n'
	// Missing stop reason is the legacy normal-completion shape; it must remain
	// copyable while non-normal reasons below stay excluded.
	turns = [{ text: raw }]
	const harness = await mountReady()

	await submit(harness, 'answer me')
	await waitUntil(() => sendCalls === 1)
	await tick(80)
	await chooseWholeResponse(harness)
	await frameShows(harness, 'Terminal, multiplexer or remote-session policy may ignore OSC 52')
	harness.stdin.write('\x0c')
	await chooseWholeResponse(harness)

	await waitUntil(() => requested.length === 2)
	expect(requested).toEqual([raw, raw])
})

it('requires the copy picker to paint before Return can select from it', async () => {
	const raw = 'paint-boundary response'
	turns = [{ text: raw }]
	const harness = await mountReady()

	await submit(harness, 'answer me')
	await waitUntil(() => sendCalls === 1)
	await tick(80)
	harness.stdin.write('/copy')
	await tick()
	harness.stdin.write('\r')
	harness.stdin.write('\r')
	await frameShows(harness, 'Copy from response')
	expect(requested).toEqual([])

	harness.stdin.write('\r')
	await waitUntil(() => requested.length === 1)
	expect(requested).toEqual([raw])
})

it('uses the previous completed answer while the next one is still streaming', async () => {
	turns = [
		{ text: 'FIRST FINISHED', stopReason: 'end_turn' },
		{ text: 'SECOND FINISHED', stopReason: 'end_turn', hold: true },
	]
	const harness = await mountReady()

	await submit(harness, 'first')
	await frameShows(harness, 'FIRST FINISHED')
	await tick(80)
	await submit(harness, 'second')
	await waitUntil(() => sendCalls === 2)
	// The second generator is now parked before `done`. Its final unterminated
	// block is intentionally still buffered, so screen text cannot be the
	// synchronisation signal here; the held generator is the completion fence.
	await tick(40)
	await openCopyPicker(harness)
	expect(requested).toEqual([])

	// The open picker owns the first completion even when a newer answer settles.
	// Selection must not re-read the live latest-output ref.
	releaseHeldTurn()
	await frameShows(harness, 'SECOND FINISHED')
	harness.stdin.write('\r')
	await waitUntil(() => requested.length === 1)
	expect(requested).toEqual(['FIRST FINISHED'])

	await chooseWholeResponse(harness)
	await waitUntil(() => requested.length === 2)
	expect(requested).toEqual(['FIRST FINISHED', 'SECOND FINISHED'])
})

it('copies exact fenced-code and prose-quote source regions', async () => {
	const raw =
		"Intro\n\n```python\r\nprint('hi')  \r\n```\r\n\r\n> quoted **source**\r\n> > nested marker\r\n"
	turns = [{ text: raw, stopReason: 'end_turn' }]
	const harness = await mountReady()

	await submit(harness, 'regions')
	await frameShows(harness, 'quoted source')
	await tick(80)
	await openCopyPicker(harness)
	await frameShows(harness, 'python code')
	await frameShows(harness, 'Blockquote')
	harness.stdin.write('\x1b[F')
	harness.stdin.write('\x1b[H')
	harness.stdin.write('\x1b[6~')
	harness.stdin.write('\x1b[5~')
	harness.stdin.write('\x1B[B')
	await frameShows(harness, '2/3')
	harness.stdin.write('\r')
	await waitUntil(() => requested.length === 1)

	await openCopyPicker(harness)
	harness.stdin.write('3')
	await waitUntil(() => requested.length === 2)

	expect(requested).toEqual([
		"print('hi')  \r\n",
		'quoted **source**\r\n> nested marker\r\n',
	])
})

it('holds queued work until the source picker closes', async () => {
	turns = [
		{ text: 'FIRST', stopReason: 'end_turn' },
		{ text: 'SECOND', stopReason: 'end_turn', hold: true },
		{ text: 'THIRD', stopReason: 'end_turn' },
	]
	const harness = await mountReady()

	await submit(harness, 'first')
	await frameShows(harness, 'FIRST')
	await tick(80)
	await submit(harness, 'second')
	await waitUntil(() => sendCalls === 2)
	await submit(harness, 'third')
	await openCopyPicker(harness)

	releaseHeldTurn()
	await frameShows(harness, 'SECOND')
	await tick(100)
	expect(sendCalls).toBe(2)
	expect(requested).toEqual([])

	harness.stdin.write('\u001b')
	await waitUntil(() => sendCalls === 3)
	await frameShows(harness, 'THIRD')
})

it('allows a bounded region even when the whole answer exceeds the clipboard limit', async () => {
	const small = 'small target\n'
	turns = [
		{
			text: `${'x'.repeat(100_001)}\n\n\`\`\`text\n${small}\`\`\`\n`,
			stopReason: 'end_turn',
		},
	]
	const harness = await mountReady()

	await submit(harness, 'large')
	await waitUntil(() => sendCalls === 1)
	await tick(100)
	await openCopyPicker(harness)
	harness.stdin.write('2')
	await waitUntil(() => requested.length === 1)

	expect(requested).toEqual([small])
})

it('does not promote partial text from an abnormal done event', async () => {
	turns = [
		{ text: 'SAFE_COMPLETE', stopReason: 'end_turn' },
		{ text: 'REFUSED_PARTIAL', stopReason: 'output_guardrail' },
	]
	const harness = await mountReady()

	await submit(harness, 'first')
	await frameShows(harness, 'SAFE_COMPLETE')
	await tick(80)
	await submit(harness, 'blocked')
	await frameShows(harness, 'REFUSED_PARTIAL')
	await tick(80)
	await chooseWholeResponse(harness)
	await waitUntil(() => requested.length === 1)

	expect(requested).toEqual(['SAFE_COMPLETE'])
})

it('hydrates the copy target from the resumed conversation, not the one left behind', async () => {
	turns = [{ text: 'OUTPUT FROM OLD CONVERSATION', stopReason: 'end_turn' }]
	recentConversations = [
		{ id: 'resumed', title: 'A resumed conversation', updatedAt: new Date().toISOString(), count: 4 },
	]
	loadedConversation = [
		createUserMessage('old question'),
		createAssistantMessage('OLDER_RESUMED_OUTPUT'),
		createUserMessage('new question'),
		createAssistantMessage('LATEST_RESUMED_RAW_MARKDOWN **here**'),
		createAssistantMessage(''),
	]
	const harness = await mountReady()

	await submit(harness, 'current question')
	await frameShows(harness, 'OUTPUT FROM OLD CONVERSATION')
	await tick(80)
	await submit(harness, '/resume')
	await frameShows(harness, 'A resumed conversation')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: A resumed conversation')
	await chooseWholeResponse(harness)
	await waitUntil(() => requested.length === 1)

	expect(requested).toEqual(['LATEST_RESUMED_RAW_MARKDOWN **here**'])
	await frameShows(harness, 'latest persisted assistant output')
})

it('clears a stale target when the resumed conversation has no assistant output', async () => {
	turns = [{ text: 'OUTPUT FROM OLD CONVERSATION', stopReason: 'end_turn' }]
	recentConversations = [
		{ id: 'resumed', title: 'User only', updatedAt: new Date().toISOString(), count: 1 },
	]
	loadedConversation = [createUserMessage('unanswered')]
	const harness = await mountReady()

	await submit(harness, 'current question')
	await frameShows(harness, 'OUTPUT FROM OLD CONVERSATION')
	await tick(80)
	await submit(harness, '/resume')
	await frameShows(harness, 'User only')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: User only')
	await submit(harness, '/copy')
	await frameShows(harness, 'Nothing to copy yet')

	expect(requested).toEqual([])
})

describe('clipboard adapter results reach the operator', () => {
	it.each([
		[
			{ kind: 'unavailable', detail: 'stdout is not an interactive terminal' } as const,
			'Cannot send a copy request here — stdout is not an interactive terminal',
		],
		[
			{ kind: 'too-large', bytes: 100_001, limit: 100_000 } as const,
			'Nothing was truncated',
		],
		[
			{ kind: 'write-failed', detail: 'stream closed' } as const,
			'Could not send the terminal copy request: stream closed',
		],
	])('reports %s', async (result, expected) => {
		turns = [{ text: 'COPY_TARGET', stopReason: 'end_turn' }]
		clipboardResult = result
		const harness = await mountReady()

		await submit(harness, 'go')
		await frameShows(harness, 'COPY_TARGET')
		await tick(80)
		await chooseWholeResponse(harness)
		await frameShows(harness, expected)

		expect(requested).toEqual(['COPY_TARGET'])
	})
})
