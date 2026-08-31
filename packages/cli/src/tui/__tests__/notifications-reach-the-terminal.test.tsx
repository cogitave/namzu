/**
 * Terminal notifications are an App boundary: semantic run state must reach
 * the terminal adapter exactly once, with queueing, interruption and
 * conversation ownership already decided. Helper tests cannot establish any
 * of those facts, so this file drives the rendered TUI end to end.
 */

import {
	type Message,
	type StopReason,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
	TerminalNotification,
	TerminalNotificationResult,
} from '../../integrations/notifications/terminal.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionRequest } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

type TurnScript = {
	readonly outcome: 'completed' | 'stopped' | 'failed' | 'paused' | 'thrown'
	readonly hold?: 'before-terminal-event' | 'after-terminal-event'
	readonly holdAfterTerminal?: boolean
	readonly asksPermission?: boolean
	readonly asksPermissionAfterHold?: boolean
}

type NotificationRequest = {
	readonly notification: TerminalNotification
	readonly method: 'osc9' | 'bel'
}

const requests: NotificationRequest[] = []
const results: TerminalNotificationResult[] = []
const scripts: TurnScript[] = []
const gates: Array<{
	readonly wait: Promise<void>
	readonly release: () => void
}> = []
const sent: Message[][] = []
const persisted: Message[][] = []
let sendCalls = 0
let clipboard: import('../../integrations/clipboard/image.js').ClipboardRead = {
	kind: 'empty',
}

let recentConversations: Array<{
	id: string
	title: string
	updatedAt: string
	count: number
}> = []

function nextGate(): {
	readonly wait: Promise<void>
	readonly release: () => void
} {
	let release: () => void = () => {}
	const wait = new Promise<void>((resolve) => {
		release = resolve
	})
	const gate = { wait, release }
	gates.push(gate)
	return gate
}

vi.mock('../../integrations/notifications/terminal.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../integrations/notifications/terminal.js')>()
	return {
		...actual,
		writeTerminalNotification: (
			notification: TerminalNotification,
			method: 'osc9' | 'bel',
		): TerminalNotificationResult => {
			requests.push({ notification, method })
			return results.shift() ?? { kind: 'request-sent' }
		},
	}
})

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => clipboard,
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'current',
	requireWritableConversation: async () => {},
	appendMessages: async (_sessions: unknown, _id: string, messages: readonly Message[]) => {
		persisted.push([...messages])
	},
	replaceConversation: async () => {},
	listRecent: async () => recentConversations,
	loadConversation: async () => [
		createUserMessage('restored question'),
		createAssistantMessage('RESTORED ANSWER'),
	],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))

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
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
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
			send: async function* (messages, opts): AsyncIterable<AgentEvent> {
				const turn = sendCalls
				sendCalls += 1
				sent.push([...messages])
				const script = scripts[turn]
				if (!script) throw new Error(`No turn script at index ${turn}`)

				const beforeGate = script.hold === 'before-terminal-event' ? nextGate() : null
				if (beforeGate) await beforeGate.wait
				// Models a credential/session refusal whose first iterator pull rejects
				// before the SDK can yield any AgentEvent.
				if (script.outcome === 'thrown') throw new Error('provider iterator threw')

				yield { kind: 'delta', text: `ANSWER ${turn}` } as AgentEvent
				const askPermission = () => {
					const request: PermissionRequest = {
						toolCalls: [
							{
								id: 'call-1',
								name: 'bash',
								input: { command: 'write output' },
								isDestructive: true,
							},
						],
					}
					// The semantic moment is opening the wait. The fake need not keep the
					// generator parked on the unresolved decision after that boundary.
					void opts?.onPermission?.(request)
				}
				if (script.asksPermission) askPermission()

				if (script.asksPermissionAfterHold) askPermission()

				if (script.outcome === 'failed') {
					yield { kind: 'error', message: 'provider failed' } as AgentEvent
				} else if (script.outcome === 'paused') {
					yield {
						kind: 'paused',
						checkpointId: 'cp_rate_7',
						reason: 'request rejected after retries',
						failure: {
							code: 'provider_error',
							message: 'request rejected after retries',
							retryable: true,
							details: { providerCode: 'rate_limit', retryAfterMs: 3_000 },
						},
						providerError: {
							kind: 'throttle',
							providerId: 'openai',
							status: 429,
							retryAfterMs: 3_000,
							detail: 'organization window exhausted',
						},
						explanation: {
							id: 'provider.rate_limit',
							message: 'The provider is rate limiting this run.',
							hint: 'Wait for the quota window to reset before continuing.',
						},
					} as AgentEvent
				} else {
					const stopReason: StopReason =
						script.outcome === 'completed' ? 'end_turn' : 'output_guardrail'
					yield { kind: 'done', stopReason } as AgentEvent
				}

				// A terminal event may be observed before the provider iterator has
				// actually unwound. This opens the ownership race with `/resume`.
				if (script.hold === 'after-terminal-event' || script.holdAfterTerminal) {
					await nextGate().wait
				}
			},
		}),
	}
})

const { App } = await import('../App.js')

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	requests.length = 0
	results.length = 0
	scripts.length = 0
	gates.length = 0
	sent.length = 0
	persisted.length = 0
	sendCalls = 0
	clipboard = { kind: 'empty' }
	recentConversations = []
})

afterEach(() => {
	for (const gate of gates) gate.release()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (!predicate() && performance.now() - started < timeoutMs) await tick(20)
	expect(predicate()).toBe(true)
}

async function frameShows(
	harness: { readonly frames: readonly string[] },
	text: string,
	timeoutMs = 3_000,
): Promise<void> {
	const expected = text.replace(/\s+/g, ' ')
	await waitUntil(
		() => harness.frames.join('\n').replace(/\s+/g, ' ').includes(expected),
		timeoutMs,
	)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

function latestUserText(history: readonly Message[]): string | undefined {
	const message = history.at(-1)
	return message?.role === 'user' && typeof message.content === 'string'
		? message.content
		: undefined
}

async function mountReady(tui?: TuiContext['tui']) {
	const ctx: TuiContext = {
		cwd: '/w',
		version: '0.0.0-test',
		...(tui ? { tui } : {}),
	}
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness, '> Type a message… (/help for commands)')
	return harness
}

it('stays silent when notifications are not configured', async () => {
	scripts.push({ outcome: 'completed' })
	const harness = await mountReady()

	await submit(harness, 'go')
	await waitUntil(() => sendCalls === 1)
	await tick(80)

	expect(requests).toEqual([])
})

it('sends approval at the actual wait boundary with the configured method', async () => {
	scripts.push({ outcome: 'completed', asksPermission: true })
	const harness = await mountReady({
		notifications: ['approval-required'],
		notificationMethod: 'bel',
	})

	await submit(harness, 'use a tool')
	await waitUntil(() => requests.length === 1)

	expect(requests).toEqual([{ notification: { kind: 'approval-required' }, method: 'bel' }])
})

it.each([
	{ scriptOutcome: 'completed', expectedOutcome: 'completed' },
	{ scriptOutcome: 'stopped', expectedOutcome: 'stopped' },
	{ scriptOutcome: 'failed', expectedOutcome: 'failed' },
	{ scriptOutcome: 'paused', expectedOutcome: 'stopped' },
	{ scriptOutcome: 'thrown', expectedOutcome: 'failed' },
] as const)(
	'maps a $scriptOutcome turn into one settled notification',
	async ({ scriptOutcome, expectedOutcome }) => {
		scripts.push({ outcome: scriptOutcome })
		const harness = await mountReady({ notifications: ['turn-settled'] })

		await submit(harness, 'go')
		await waitUntil(() => requests.length === 1)

		expect(requests).toEqual([
			{
				notification: { kind: 'turn-settled', outcome: expectedOutcome },
				method: 'osc9',
			},
		])
	},
)

it('suppresses the first settlement while queued work immediately continues', async () => {
	scripts.push({ outcome: 'completed', hold: 'before-terminal-event' }, { outcome: 'completed' })
	const harness = await mountReady({ notifications: ['turn-settled'] })

	await submit(harness, 'first')
	await waitUntil(() => gates.length === 1)
	await submit(harness, 'queued second')
	await frameShows(harness, 'queued')
	gates[0]?.release()
	await waitUntil(() => sendCalls === 2 && requests.length === 1)

	expect(requests).toEqual([
		{
			notification: { kind: 'turn-settled', outcome: 'completed' },
			method: 'osc9',
		},
	])
})

it.each([
	{ outcome: 'failed', label: 'failed' },
	{ outcome: 'stopped', label: 'stopped' },
] as const)(
	'pauses dependent queued work after a $label human turn',
	async ({ outcome, label }) => {
		scripts.push({ outcome, hold: 'before-terminal-event' }, { outcome: 'completed' })
		const harness = await mountReady({ notifications: ['turn-settled'] })

		await submit(harness, 'first premise')
		await waitUntil(() => gates.length === 1)
		await submit(harness, 'depends on first')
		gates[0]?.release()
		await frameShows(harness, `paused after a ${label} turn`)
		await tick(100)

		expect(sendCalls, 'the dependent prompt ran after its premise failed').toBe(1)
		expect(requests).toEqual([{ notification: { kind: 'turn-settled', outcome }, method: 'osc9' }])
	},
)

it('explains a resumable pause and holds dependent queued work', async () => {
	scripts.push({ outcome: 'paused', hold: 'before-terminal-event' }, { outcome: 'completed' })
	const harness = await mountReady({ notifications: ['turn-settled'] })

	await submit(harness, 'first premise')
	await waitUntil(() => gates.length === 1)
	await submit(harness, 'depends on first')
	gates[0]?.release()

	await frameShows(harness, 'Run paused [provider.rate_limit]: The provider is rate limiting this run.')
	await frameShows(harness, 'Provider retry delay: at least 3 seconds from this failure.')
	await frameShows(harness, 'Next: Wait for the quota window to reset before continuing.')
	await frameShows(harness, 'Checkpoint preserved: cp_rate_7')
	await frameShows(harness, 'held after a resumable run paused')
	await tick(100)

	expect(sendCalls, 'the dependent prompt ran after a resumable stop').toBe(1)
	expect(requests).toEqual([
		{ notification: { kind: 'turn-settled', outcome: 'stopped' }, method: 'osc9' },
	])
})

it('lets a post-error human continuation release the earlier FIFO before finally runs', async () => {
	scripts.push(
		{
			outcome: 'failed',
			hold: 'before-terminal-event',
			holdAfterTerminal: true,
		},
		{ outcome: 'completed' },
		{ outcome: 'completed' },
	)
	const harness = await mountReady()

	await submit(harness, 'first premise')
	await waitUntil(() => gates.length === 1)
	await submit(harness, 'queued before failure')
	gates[0]?.release()
	await frameShows(harness, 'Error: provider failed')
	await waitUntil(() => gates.length === 2)
	await submit(harness, 'continue after seeing failure')
	gates[1]?.release()
	await waitUntil(() => sendCalls === 3)

	expect(sent.map(latestUserText)).toEqual([
		'first premise',
		'queued before failure',
		'continue after seeing failure',
	])
	expect(harness.lastFrame()).not.toContain('paused after a failed turn')
})

it('pauses a pre-event throw, persists its attachment, and resumes FIFO on explicit input', async () => {
	const firstImage = { data: 'FIRST', mediaType: 'image/png' as const }
	clipboard = { kind: 'image', image: firstImage }
	scripts.push(
		{ outcome: 'thrown', hold: 'before-terminal-event' },
		{ outcome: 'completed' },
		{ outcome: 'completed' },
	)
	const harness = await mountReady({ notifications: ['turn-settled'] })

	harness.stdin.write('\x16')
	await frameShows(harness, 'Image #1')
	await submit(harness, 'attached premise')
	await waitUntil(() => gates.length === 1)
	await submit(harness, 'queued before throw')
	gates[0]?.release()
	await frameShows(harness, 'paused after a failed turn')
	await waitUntil(() => persisted.length === 1)

	expect(sendCalls).toBe(1)
	expect(requests).toEqual([
		{
			notification: { kind: 'turn-settled', outcome: 'failed' },
			method: 'osc9',
		},
	])
	const durableUser = persisted[0]?.[0]
	expect(durableUser?.role === 'user' ? durableUser.attachments : undefined).toEqual([firstImage])

	await submit(harness, 'continue explicitly')
	await waitUntil(() => sendCalls === 3)
	expect(sent.map(latestUserText)).toEqual([
		'attached premise',
		'queued before throw',
		'continue explicitly',
	])
	const priorInDependentTurn = sent[1]?.find(
		(message) => message.role === 'user' && message.content === 'attached premise',
	)
	expect(
		priorInDependentTurn?.role === 'user' ? priorInDependentTurn.attachments : undefined,
	).toEqual([firstImage])
})

it('does not notify for a manually interrupted turn', async () => {
	scripts.push({ outcome: 'completed', hold: 'before-terminal-event' })
	const harness = await mountReady({ notifications: ['turn-settled'] })

	await submit(harness, 'hold')
	await waitUntil(() => gates.length === 1)
	harness.stdin.write('\x1B')
	await tick(100)
	gates[0]?.release()
	await tick(120)

	expect(requests).toEqual([])
})

it('cannot emit a late approval or settlement after /resume gives ownership away', async () => {
	scripts.push(
		{
			outcome: 'completed',
			hold: 'before-terminal-event',
			asksPermissionAfterHold: true,
		},
		{ outcome: 'completed' },
	)
	recentConversations = [
		{
			id: 'resumed',
			title: 'Earlier work',
			updatedAt: new Date().toISOString(),
			count: 2,
		},
	]
	const harness = await mountReady({ notifications: true })

	await submit(harness, 'old turn')
	await waitUntil(() => gates.length === 1)
	await submit(harness, '/resume')
	await frameShows(harness, 'Earlier work')
	harness.stdin.write('\r')
	await frameShows(harness, 'Resumed: Earlier work')
	await submit(harness, 'new turn')
	await waitUntil(() => sendCalls === 2 && requests.length === 1)

	// The abandoned provider asks for approval only after the switch. It has
	// lost ownership of both the screen and notification channel by then.
	gates[0]?.release()
	await tick(150)
	expect(requests).toEqual([
		{
			notification: { kind: 'turn-settled', outcome: 'completed' },
			method: 'osc9',
		},
	])
})

describe('terminal adapter failure reporting', () => {
	it('reports the first failure and suppresses later noise', async () => {
		scripts.push({ outcome: 'completed' }, { outcome: 'completed' })
		results.push(
			{ kind: 'write-failed', detail: 'FIRST WRITE FAILURE' },
			{ kind: 'write-failed', detail: 'SECOND WRITE FAILURE' },
		)
		const harness = await mountReady({ notifications: true })

		await submit(harness, 'first')
		await frameShows(harness, 'FIRST WRITE FAILURE')
		await submit(harness, 'second')
		await waitUntil(() => requests.length === 2)
		await tick(80)

		const allFrames = harness.frames.join('\n')
		expect(allFrames).toContain('FIRST WRITE FAILURE')
		expect(allFrames).not.toContain('SECOND WRITE FAILURE')
	})
})
