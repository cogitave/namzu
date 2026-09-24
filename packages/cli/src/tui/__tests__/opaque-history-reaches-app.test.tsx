/**
 * App replays exact kernel history without rendering opaque state.
 *
 * The kernel's turn recorder owns persistence: the fake session below records
 * each turn into the conversation's log the way `query()` does, and App's part
 * is to hand the next turn the folded history byte-for-byte.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createAssistantMessage,
	createToolMessage,
	createUserMessage,
	type Message,
	type SessionGoalStore,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { recordTurn } from '../../__fixtures__/session-log.js'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { CliSessions } from '../../integrations/sessions/store.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SessionScope, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const HIDDEN_REASONING = 'HIDDEN_REASONING_MUST_NOT_RENDER'
const HIDDEN_SIGNATURE = 'opaque-signature-exact'
const HIDDEN_ENCRYPTED = 'opaque-encrypted-exact'

let scope: SessionScope | undefined
const sent: Message[][] = []

/**
 * `recordTurn` (the fixture below stands in for the kernel's own recorder)
 * writes each message under a fresh id but does not stamp it back onto the
 * caller's own object the way `TurnRecorder` does — so `durable`, read back
 * from disk, carries ids that `sent`, built from the fixture's own
 * `onConversationMessages` publication, never got stamped with. Comparing
 * two durable reads of the SAME conversation needs no such stripping: both
 * go through `loadConversation` and agree on the log's own ids.
 */
const withoutIds = (messages: readonly Message[]): Message[] =>
	messages.map(({ id: _id, ...rest }) => rest as Message)

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
			options: {
				readonly scope?: SessionScope
				readonly sessionGoals?: SessionGoalStore
				readonly conversationSessions?: unknown
			},
		): Promise<AgentSession> => {
			scope = options.scope
			const conversations = options.conversationSessions as CliSessions | undefined
			// What the kernel records at the end of a turn: the turn's new messages.
			const record = async (prior: readonly Message[], turn: readonly Message[]) => {
				const sessionId = scope?.sessionId
				if (!conversations || !sessionId) return
				await recordTurn(conversations, sessionId, turn.slice(prior.length - 1))
			}
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'opaque-provider',
				modelSummary: 'opaque-model',
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
				approvalLatched: () => false,
				promptExemptTools: () => [],
				resumeDurable: async () => {
					throw new Error('not used')
				},
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
				},
				close: async () => {},
				send: async function* (
					messages: readonly Message[],
					sendOptions?: SendOptions,
				): AsyncIterable<AgentEvent> {
					sent.push([...messages])
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
						const turn = [...messages, call, result, answer]
						yield { kind: 'delta', text: 'VISIBLE ANSWER' }
						await record(messages, turn)
						yield { kind: 'done', stopReason: 'end_turn' }
						sendOptions?.onConversationMessages?.(turn)
						return
					}
					const answer = createAssistantMessage('SECOND ANSWER')
					const turn = [...messages, answer]
					yield { kind: 'delta', text: 'SECOND ANSWER' }
					await record(messages, turn)
					yield { kind: 'done', stopReason: 'end_turn' }
					sendOptions?.onConversationMessages?.(turn)
				},
			}
		},
	}
})

const { App } = await import('../App.js')
const { loadConversation, openSessions, startConversation } = await import(
	'../../integrations/sessions/store.js'
)
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
	await vi.waitFor(() => expect(check(), why).toBe(true))
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

it('resumes public message parts without blank rows and sends the original tool/replay history', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resume-public-parts-'))
	roots.push(root)
	const sessions = await openSessions(root)
	const sessionId = await startConversation(sessions)
	const call = createAssistantMessage(null, [
		{
			id: 'seed-call',
			type: 'function',
			function: { name: 'read', arguments: '{"path":"notes.txt"}' },
		},
	])
	const answer = createAssistantMessage('SAVED FINAL', undefined, [
		{
			type: 'thinking',
			text: HIDDEN_REASONING,
			signature: HIDDEN_SIGNATURE,
			encrypted: HIDDEN_ENCRYPTED,
		},
	])
	answer.textParts = [
		{ id: 'progress', phase: 'commentary', text: 'SAVED PROGRESS' },
		{ id: 'final', phase: 'final_answer', text: 'SAVED FINAL' },
	]
	const history = [
		createUserMessage('saved question'),
		call,
		createToolMessage('original tool result', 'seed-call'),
		answer,
	]
	await recordTurn(sessions, sessionId, history)
	const durable = await loadConversation(sessions, sessionId)
	const harness = render(
		<App
			ctx={{ cwd: root, version: '0.0.0-test', initialConversationId: sessionId } as TuiContext}
		/>,
	)
	mounted.push(harness)
	await until(
		() =>
			harness.frames.join('\n').includes('SAVED FINAL') &&
			(harness.lastFrame() ?? '').includes('Type a message'),
		'the resumed conversation did not become ready',
	)
	const rendered = harness.frames.join('\n')
	expect(rendered).toContain('SAVED PROGRESS')
	expect(rendered).not.toMatch(/^\s*∴\s*$/m)
	expect(rendered).not.toContain(HIDDEN_REASONING)
	expect(rendered).not.toContain(HIDDEN_SIGNATURE)
	expect(rendered).not.toContain(HIDDEN_ENCRYPTED)
	await submit(harness, 'continue the saved conversation')
	await until(() => sent.length === 1, 'the continuation did not reach the session')
	// A resumed conversation's `modelHistoryRef` is a fresh disk read too, so
	// it carries the same ids `durable` does — no stripping needed here,
	// unlike the live-continuation case below.
	expect(sent[0]?.slice(0, durable.length)).toEqual(durable)
	// Wait for the actual publication before unmounting; a late write must not
	// spill into the following test's store spies or race directory cleanup.
	await vi.waitFor(
		async () => {
			const continued = await loadConversation(sessions, sessionId)
			expect(continued).toHaveLength(durable.length + 4)
			expect(continued.slice(0, durable.length)).toEqual(durable)
		},
		{ timeout: 5_000 },
	)
})

it('reopens the exact tool/reasoning history and sends it next turn', async () => {
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
	const rendered = harness.frames.join('\n')
	expect(rendered).not.toContain(HIDDEN_REASONING)
	expect(rendered).not.toContain(HIDDEN_SIGNATURE)
	expect(rendered).not.toContain(HIDDEN_ENCRYPTED)

	await submit(harness, 'second question')
	await until(() => sent.length === 2, 'the second turn never reached the session')
	expect(sent[1]?.slice(0, 4)).toEqual(withoutIds(durable))
	await vi.waitFor(
		async () => {
			const continued = await loadConversation(sessions, sessionId)
			expect(continued).toHaveLength(6)
			expect(continued.slice(0, 4)).toEqual(durable)
		},
		{ timeout: 5_000 },
	)
})
