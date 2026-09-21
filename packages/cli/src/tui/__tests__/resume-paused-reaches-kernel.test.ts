/**
 * `session.resumePaused` hands the kernel's resume this session's own turn.
 *
 * The pause itself is proven elsewhere (`paused-turn-reaches-session`). What
 * this pins is the half a headless caller cannot see: the turn is addressed
 * under THIS session's ids and the same turn id, the checkpoint the pause
 * named is the one asked for, the log is the conversation's own, and the
 * events the kernel hands a listener come back out as the same stream `send`
 * gives — ending with an error, not silence, when there was nothing to resume.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type SessionEvent, asTurnId, generateMessageId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import {
	conversationLogPath,
	openConversationLog,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'

const resumeCalls: Record<string, unknown>[] = []
let resumeOutcome: unknown = { resumed: true, turn: {}, state: {} }

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		resumeSession: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			const listener = params.listener as ((event: SessionEvent) => void) | undefined
			listener?.({
				type: 'text_delta',
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				text: 'picked up ',
			} as unknown as SessionEvent)
			listener?.({
				type: 'text_delta',
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				text: 'where it left off',
			} as unknown as SessionEvent)
			return resumeOutcome
		},
	}
})

const preferences = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: 'env',
		apiKey: 'sk-ant-not-a-real-key',
		alternatives: [],
	} as unknown as DetectedProvider,
]

const roots: string[] = []

afterEach(() => {
	resumeCalls.length = 0
	resumeOutcome = { resumed: true, turn: {}, state: {} }
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function openSession() {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-resume-paused-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-resume-paused-state-'))
	roots.push(cwd, stateRoot)
	const conversations = await openSessions(cwd, { stateRoot })
	const scope = {
		sessionId: await startConversation(conversations),
		topicId: conversations.topicId,
		projectId: conversations.projectId,
		tenantId: conversations.tenantId,
	}
	const { createAgentSession } = await import('../agent.js')
	return {
		session: await createAgentSession(preferences, detected, {
			cwd,
			stateRoot,
			scope,
			conversationSessions: conversations,
		}),
		scope,
		stateRoot,
		conversations,
	}
}

/** Open a turn in the conversation's log with the limits it recorded. */
async function recordTurnStart(
	conversations: Awaited<ReturnType<typeof openSessions>>,
	sessionId: Parameters<typeof openConversationLog>[1],
	config: Record<string, number>,
) {
	const log = openConversationLog(conversations, sessionId)
	const lease = await log.claim({ holder: 'test-resume', ttlMs: 10_000 })
	if (!lease) throw new Error('fixture could not lease the log')
	await log.beginTurn(lease, {
		turnId: asTurnId('3b0329bb-f60a-48dc-9552-1b386c52cfe8'),
		userMessageId: generateMessageId(),
		config: { model: 'test-model', ...config } as never,
	})
	await log.release(lease)
}

describe('resuming this session’s own paused turn', () => {
	it.each([
		{ tokenBudget: 12000, maxIterations: 7, timeoutMs: 120000 },
		{ tokenBudget: 0, maxIterations: 0, timeoutMs: 0 },
	])('reopens a paused turn with its recorded limits: %j', async (limits) => {
		const { session, scope, conversations } = await openSession()
		await recordTurnStart(conversations, scope.sessionId, limits)
		try {
			for await (const event of session.resumePaused({
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'error') throw new Error(event.message)
			}
			expect(resumeCalls[0]?.turnConfig).toMatchObject(limits)
		} finally {
			await session.close()
		}
	})

	it('refuses a turn whose recorded limits are incomplete instead of running it unlimited', async () => {
		const { session, scope, conversations } = await openSession()
		await recordTurnStart(conversations, scope.sessionId, { tokenBudget: 5, timeoutMs: 5 })
		const errors: string[] = []
		try {
			for await (const event of session.resumePaused({
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'error') errors.push(event.message)
			}
			expect(errors.join(' ')).toContain('limits')
			expect(resumeCalls).toHaveLength(0)
		} finally {
			await session.close()
		}
	})

	it('addresses the turn under the session’s ids, at the checkpoint named, in the conversation’s log', async () => {
		const { session, scope, conversations } = await openSession()
		const texts: string[] = []
		try {
			for await (const event of session.resumePaused({
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'delta') texts.push(event.text)
				if (event.kind === 'error') throw new Error(`unexpected error: ${event.message}`)
			}
		} finally {
			await session.close()
		}

		expect(texts.join('')).toBe('picked up where it left off')
		expect(resumeCalls).toHaveLength(1)
		const call = resumeCalls[0] as {
			scope: Record<string, string>
			checkpointId: string
			checkpointStore: { constructor: { name: string } }
			sessionLog: { file: string }
			tenantId: string
			projectId: string
			sessionId: string
			topicId: string
		}
		expect(call.scope).toEqual({ ...scope, turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8' })
		expect(call.checkpointId).toBe('f0d1dd26-fd58-4593-b904-7817c789af26')
		expect(call.tenantId).toBe(scope.tenantId)
		expect(call.projectId).toBe(scope.projectId)
		expect(call.sessionId).toBe(scope.sessionId)
		expect(call.topicId).toBe(scope.topicId)
		// The conversation's own log, and its checkpoints beside it.
		expect(call.sessionLog.file).toBe(conversationLogPath(conversations, scope.sessionId))
		expect(call.checkpointStore.constructor.name).toBe('DiskSessionCheckpointStore')
	})

	it('ends with an error, not silence, when the checkpoint is not there', async () => {
		resumeOutcome = { resumed: false, reason: 'no-checkpoint' }
		const { session } = await openSession()
		const kinds: string[] = []
		let message = ''
		try {
			for await (const event of session.resumePaused({
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: '7c81157d-b597-49f9-b951-772a567ecdf2',
			})) {
				kinds.push(event.kind)
				if (event.kind === 'error') message = event.message
			}
		} finally {
			await session.close()
		}

		expect(kinds.at(-1)).toBe('error')
		expect(message).toContain('7c81157d-b597-49f9-b951-772a567ecdf2')
		expect(message).toContain('3b0329bb-f60a-48dc-9552-1b386c52cfe8')
	})

	it('does not resume past a turn parked on a human decision', async () => {
		resumeOutcome = { resumed: false, reason: 'awaiting-decision', pending: {}, state: {} }
		const { session } = await openSession()
		let message = ''
		try {
			for await (const event of session.resumePaused({
				turnId: '3b0329bb-f60a-48dc-9552-1b386c52cfe8',
				checkpointId: 'f0d1dd26-fd58-4593-b904-7817c789af26',
			})) {
				if (event.kind === 'error') message = event.message
			}
		} finally {
			await session.close()
		}

		expect(message).toMatch(/parked on a decision/)
	})
})
