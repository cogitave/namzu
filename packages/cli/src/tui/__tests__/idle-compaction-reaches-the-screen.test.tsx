/**
 * Compacting while idle is an App boundary: the cache lifetime a reply
 * reports, the minute of quiet, the turn and dialog state and the compaction
 * call have to meet on the real screen. The decision itself is tested in
 * `integrations/compaction/idle-compaction.test.ts`; this drives the rendered
 * TUI with the production event mapper and a clock the test turns by hand.
 */

import { type Message, type TurnId, createAssistantMessage } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IDLE_COMPACTION_NOTICE } from '../../integrations/compaction/idle-compaction.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}
const HOUR = 3_600_000

type Reply = { readonly cacheTtlMs?: number; readonly contextTokens: number }
const replies: Reply[] = []
const compactCalls: Array<{ messages: readonly Message[]; trigger: string | undefined }> = []
let idleSetting: { minTokens: number } | undefined

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
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
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			promptExemptTools: () => [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('not part of this test')
			},
			close: async () => {},
			...(idleSetting ? { idleCompaction: idleSetting } : {}),
			compact: async (messages, _instructions, trigger) => {
				compactCalls.push({ messages, trigger })
				const summary = createAssistantMessage('SUMMARY OF EARLIER WORK')
				return { messages: [summary], shed: 2, summary, usage: ZERO_USAGE }
			},
			send: async function* (): AsyncIterable<AgentEvent> {
				const reply = replies.shift() ?? { contextTokens: 10 }
				yield { kind: 'delta', text: 'ANSWER' } as AgentEvent
				yield actual.toAgentEvent(
					{
						type: 'token_usage_updated',
						sessionId: '019a0000-0000-7000-8000-0000000000f2' as never,
						turnId: '4ac54cdc-8544-408d-9644-81a89368a5a0' as TurnId,
						usage: { ...ZERO_USAGE, totalTokens: 100 },
						cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
						...(reply.cacheTtlMs !== undefined
							? { cache: { ttlMs: reply.cacheTtlMs, touched: true } }
							: {}),
						contextTokens: reply.contextTokens,
						contextMeasuredBy: 'provider',
						contextWindowTokens: 1_000_000,
						windowSource: 'provider',
					},
					{} as never,
				) as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	replies.length = 0
	compactCalls.length = 0
	idleSetting = { minTokens: 200_000 }
	// Only the clock the code under test reads is faked, and only the test moves
	// it (advanceTimersByTimeAsync). Waiting for the screen yields to the event
	// loop and looks again; it never turns the clock, so how fast the host is
	// cannot change which side of a threshold an assertion lands on.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})

afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
	vi.restoreAllMocks()
})

const flat = (harness: { readonly frames: readonly string[] }) =>
	harness.frames.join('\n').replace(/\s+/g, '')

/** Look again after each turn of the event loop (setImmediate is not faked). */
async function until(read: () => boolean, why: string): Promise<void> {
	for (let turn = 0; turn < 2_000; turn++) {
		if (read()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(read(), why).toBe(true)
}

async function frameShows(harness: { readonly frames: readonly string[] }, text: string) {
	const expected = text.replace(/\s+/g, '')
	await until(() => flat(harness).includes(expected), `never showed: ${text}`)
}

const lastFrameShows = (harness: { lastFrame: () => string | undefined }, text: string) =>
	until(() => (harness.lastFrame() ?? '').includes(text), `never showed: ${text}`)

const lastFrameLacks = (harness: { lastFrame: () => string | undefined }, text: string) =>
	until(() => !(harness.lastFrame() ?? '').includes(text), `still showing: ${text}`)

async function mountAndAnswer(reply: Reply) {
	replies.push(reply)
	const harness = render(<App ctx={{ cwd: '/w', version: '0.0.0-test' }} />)
	mounted.push(harness)
	await frameShows(harness, '❯ Type a message… (/help for commands)')
	harness.stdin.write('go')
	await vi.advanceTimersByTimeAsync(40)
	harness.stdin.write('\r')
	await frameShows(harness, 'ANSWER')
	return harness
}

describe('compacting while idle', () => {
	it('compacts a large conversation before a one-hour cache expires and says so once', async () => {
		const harness = await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 400_000 })
		expect(compactCalls).toEqual([])

		await vi.advanceTimersByTimeAsync(0.9 * HOUR + 1_000)

		await frameShows(harness, IDLE_COMPACTION_NOTICE)
		expect(compactCalls).toHaveLength(1)
		expect(compactCalls[0]?.trigger).toBe('idle')
		// The conversation the next reply receives is the compacted one.
		const sent = compactCalls[0]?.messages ?? []
		expect(sent.some((m) => m.role === 'user' && m.content === 'go')).toBe(true)
		await vi.advanceTimersByTimeAsync(2 * HOUR)
		expect(compactCalls).toHaveLength(1)
	})

	it('adds nothing and calls nothing for a small conversation', async () => {
		const harness = await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 50_000 })
		await vi.advanceTimersByTimeAsync(2 * HOUR)
		expect(compactCalls).toEqual([])
		expect(flat(harness)).not.toContain('Compactedwhileidle')
	})

	it('does nothing for a five-minute cache', async () => {
		const harness = await mountAndAnswer({ cacheTtlMs: 300_000, contextTokens: 400_000 })
		await vi.advanceTimersByTimeAsync(2 * HOUR)
		expect(compactCalls).toEqual([])
		expect(flat(harness)).not.toContain('Compactedwhileidle')
	})

	it('does nothing when the driver reports no cache lifetime', async () => {
		await mountAndAnswer({ contextTokens: 400_000 })
		await vi.advanceTimersByTimeAsync(2 * HOUR)
		expect(compactCalls).toEqual([])
	})

	it('does nothing while the setting is off', async () => {
		idleSetting = undefined
		await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 400_000 })
		await vi.advanceTimersByTimeAsync(2 * HOUR)
		expect(compactCalls).toEqual([])
	})

	it('does nothing when the person was at the keyboard in the last minute', async () => {
		const harness = await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 400_000 })
		await vi.advanceTimersByTimeAsync(0.9 * HOUR - 20_000)
		harness.stdin.write('x')
		await vi.advanceTimersByTimeAsync(30_000)
		expect(compactCalls).toEqual([])
	})

	it('takes the context meter down, as any compaction does, until the next reply', async () => {
		// 970k of a 1M window is past the point where the footer says how much is left.
		const harness = await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 970_000 })
		await lastFrameShows(harness, 'until auto-compact')

		await vi.advanceTimersByTimeAsync(0.9 * HOUR + 1_000)
		await frameShows(harness, IDLE_COMPACTION_NOTICE)
		await lastFrameLacks(harness, 'until auto-compact')
	})

	it('leaves the history alone while the detailed transcript is open', async () => {
		const harness = await mountAndAnswer({ cacheTtlMs: HOUR, contextTokens: 400_000 })
		harness.stdin.write('\x0f')
		await lastFrameShows(harness, 'Showing detailed transcript')

		await vi.advanceTimersByTimeAsync(0.9 * HOUR + 1_000)
		expect(compactCalls).toEqual([])
		expect(harness.lastFrame() ?? '').toContain('Showing detailed transcript')
	})
})
