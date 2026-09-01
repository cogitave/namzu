/** App persists and replays exact kernel history without rendering opaque state. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DiskSessionStore,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	type Message,
	type SessionGoalStore,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, RunScope, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const HIDDEN_REASONING = 'HIDDEN_REASONING_MUST_NOT_RENDER'
const HIDDEN_SIGNATURE = 'opaque-signature-exact'
const HIDDEN_ENCRYPTED = 'opaque-encrypted-exact'

let scope: RunScope | undefined
const sent: Message[][] = []

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (
			_preferences: Preferences,
			_detected: readonly unknown[],
			options: { readonly scope?: RunScope; readonly sessionGoals?: SessionGoalStore },
		): Promise<AgentSession> => {
			scope = options.scope
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'opaque-provider',
				modelSummary: 'opaque-model',
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
				resumeDurable: async () => {
					throw new Error('not used')
				},
				close: async () => {},
				send: async function* (
					messages: readonly Message[],
					sendOptions?: SendOptions,
				): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					if (messages.at(-1)?.content === 'compact this turn') {
						const summary = {
							...createSystemMessage(
								'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.\n\ncompacted exact',
							),
							retain: true,
						}
						const user = messages.at(-1)
						if (!user) throw new Error('fixture requires the current user message')
						const answer = createAssistantMessage('COMPACTED ANSWER')
						yield { kind: 'delta', text: 'COMPACTED ANSWER' }
						yield { kind: 'done', stopReason: 'end_turn' }
						sendOptions?.onConversationMessages?.([summary, user, answer])
						return
					}
					if (sent.length === 1) {
						const call = createAssistantMessage(null, [
							{
								id: 'call_opaque',
								type: 'function',
								function: { name: 'read', arguments: '{"path":"notes.txt"}' },
							},
						])
						const result = createToolMessage('tool result exact', 'call_opaque')
						const answer = createAssistantMessage('VISIBLE ANSWER', undefined, [
							{
								type: 'thinking',
								text: HIDDEN_REASONING,
								signature: HIDDEN_SIGNATURE,
								encrypted: HIDDEN_ENCRYPTED,
							},
						])
						yield { kind: 'delta', text: 'VISIBLE ANSWER' }
						yield { kind: 'done', stopReason: 'end_turn' }
						sendOptions?.onConversationMessages?.([...messages, call, result, answer])
						return
					}
					const answer = createAssistantMessage('SECOND ANSWER')
					yield { kind: 'delta', text: 'SECOND ANSWER' }
					yield { kind: 'done', stopReason: 'end_turn' }
					sendOptions?.onConversationMessages?.([...messages, answer])
				},
			}
		},
	}
})

const { App } = await import('../App.js')
const { loadConversation, openSessions } = await import('../../integrations/sessions/store.js')
const roots: string[] = []
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	for (const harness of mounted.splice(0)) harness.unmount()
	for (const root of roots.splice(0)) removeTempDir(root)
	scope = undefined
	sent.length = 0
	vi.restoreAllMocks()
})

async function until(check: () => boolean, why: string): Promise<void> {
	const started = performance.now()
	while (!check() && performance.now() - started < 5_000) await tick(20)
	expect(check(), why).toBe(true)
}

async function submit(
	harness: { stdin: { write: (value: string) => void } },
	text: string,
): Promise<void> {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
	await tick(50)
}

it('reopens the exact tool/reasoning history and sends it next turn', async () => {
	const replacements = vi.spyOn(DiskSessionStore.prototype, 'replaceMessages')
	const appends = vi.spyOn(DiskSessionStore.prototype, 'appendMessage')
	const root = await mkdtemp(join(tmpdir(), 'namzu-opaque-history-app-'))
	roots.push(root)
	const harness = render(<App ctx={{ cwd: root, version: '0.0.0-test' } as TuiContext} />)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')

	await submit(harness, 'first question')
	await until(() => sent.length === 1, 'the first turn never reached the session')
	const sessionId = scope?.sessionId
	if (!sessionId) throw new Error('fixture requires the active session id')
	await until(
		() => harness.frames.join('\n').includes('VISIBLE ANSWER'),
		'the visible answer never reached the transcript',
	)

	const sessions = await openSessions(root)
	let durable: readonly Message[] = []
	await vi.waitFor(
		async () => {
			durable = await loadConversation(sessions, sessionId)
			expect(durable).toHaveLength(4)
		},
		{ timeout: 5_000 },
	)
	expect(durable[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'call_opaque' }] })
	expect(durable[2]).toMatchObject({ role: 'tool', toolCallId: 'call_opaque' })
	expect(durable[3]).toMatchObject({
		role: 'assistant',
		content: 'VISIBLE ANSWER',
		reasoning: [
			{
				type: 'thinking',
				text: HIDDEN_REASONING,
				signature: HIDDEN_SIGNATURE,
				encrypted: HIDDEN_ENCRYPTED,
			},
		],
	})
	expect(replacements).toHaveBeenCalledTimes(1)
	expect(appends).not.toHaveBeenCalled()
	const rendered = harness.frames.join('\n')
	expect(rendered).not.toContain(HIDDEN_REASONING)
	expect(rendered).not.toContain(HIDDEN_SIGNATURE)
	expect(rendered).not.toContain(HIDDEN_ENCRYPTED)

	await submit(harness, 'second question')
	await until(() => sent.length === 2, 'the second turn never reached the session')
	expect(sent[1]?.slice(0, 4)).toEqual(durable)
	await vi.waitFor(
		async () => {
			const continued = await loadConversation(sessions, sessionId)
			expect(continued).toHaveLength(6)
			expect(continued.slice(0, 4)).toEqual(durable)
		},
		{ timeout: 5_000 },
	)
})

it('atomically replaces a prefix changed by in-run compaction', async () => {
	const replacements = vi.spyOn(DiskSessionStore.prototype, 'replaceMessages')
	const appends = vi.spyOn(DiskSessionStore.prototype, 'appendMessage')
	const root = await mkdtemp(join(tmpdir(), 'namzu-compacted-history-app-'))
	roots.push(root)
	const harness = render(<App ctx={{ cwd: root, version: '0.0.0-test' } as TuiContext} />)
	mounted.push(harness)
	await until(() => scope?.sessionId !== undefined, 'the durable conversation never became ready')

	await submit(harness, 'compact this turn')
	await until(() => sent.length === 1, 'the compacting turn never reached the session')
	const sessionId = scope?.sessionId
	if (!sessionId) throw new Error('fixture requires the active session id')
	const sessions = await openSessions(root)
	let durable: readonly Message[] = []
	await vi.waitFor(
		async () => {
			durable = await loadConversation(sessions, sessionId)
			expect(durable).toHaveLength(3)
		},
		{ timeout: 5_000 },
	)

	expect(durable[0]).toMatchObject({ role: 'system', retain: true })
	expect(durable[1]).toMatchObject({ role: 'user', content: 'compact this turn' })
	expect(durable[2]).toMatchObject({ role: 'assistant', content: 'COMPACTED ANSWER' })
	expect(replacements).toHaveBeenCalledTimes(1)
	expect(appends).not.toHaveBeenCalled()
})
