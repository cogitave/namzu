/**
 * The seams a scheduled run and its answer travel through.
 *
 * A turn nobody watches must never approve on its own: `SendOptions.reviewHold`
 * parks every batch the policy would put to a person. The operator answering
 * that park later must answer exactly the parked batch
 * (`ResumePausedParams.pendingDecision`), be asked about later calls live
 * (`onPermission`), and stay under the job's rules rather than the folder's
 * (`rules`). Without any of these, `/resume` behaves as it always did.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AuthorizationRule, type SessionEvent, asTurnId, generateMessageId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import {
	openConversationLog,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { makeHoldingResumeHandler, makeResumeHandler } from '../agent.js'

const resumeCalls: Record<string, unknown>[] = []
let duringResume: ((params: Record<string, unknown>) => Promise<void>) | undefined

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		resumeSession: async (params: Record<string, unknown>) => {
			resumeCalls.push(params)
			await duringResume?.(params)
			const listener = params.listener as ((event: SessionEvent) => void) | undefined
			listener?.({ type: 'text_delta', turnId: TURN, text: 'ok' } as unknown as SessionEvent)
			return { resumed: true, turn: {}, state: {} }
		},
	}
})

const TURN = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'
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
	duringResume = undefined
	for (const root of roots.splice(0)) removeTempDir(root)
})

const bashBatch = {
	type: 'tool_review',
	sessionId: 'ses_x',
	turnId: TURN,
	checkpointId: 'cp',
	toolCalls: [{ id: 'c1', name: 'bash', input: { command: 'rm -r build' }, isDestructive: false }],
} as never

async function openSession(rules?: readonly AuthorizationRule[]) {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-sched-seam-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-sched-seam-state-'))
	roots.push(cwd, stateRoot)
	const conversations = await openSessions(cwd, { stateRoot })
	const scope = {
		sessionId: await startConversation(conversations),
		topicId: conversations.topicId,
		projectId: conversations.projectId,
		tenantId: conversations.tenantId,
	}
	const log = openConversationLog(conversations, scope.sessionId)
	const lease = await log.claim({ holder: 'fixture', ttlMs: 10_000 })
	if (!lease) throw new Error('no lease')
	await log.beginTurn(lease, {
		turnId: asTurnId(TURN),
		userMessageId: generateMessageId(),
		config: { model: 'test-model', tokenBudget: 0, maxIterations: 0, timeoutMs: 0 } as never,
	})
	await log.release(lease)
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot,
		scope,
		conversationSessions: conversations,
		...(rules ? { rules } : {}),
	})
	return session
}

type Call = {
	resumeHandler: (request: never) => Promise<{ action: string; reason?: string }>
	authorizationGate: { rules: AuthorizationRule[] }
	pendingDecision?: unknown
}

async function drain(stream: AsyncIterable<{ kind: string; message?: string }>): Promise<void> {
	for await (const event of stream) if (event.kind === 'error') throw new Error(event.message)
}

describe('holding instead of approving', () => {
	it('the holding handler parks every batch that would reach a person, in every mode but strict', async () => {
		const exempt = () => false
		for (const mode of ['prompt', 'auto', 'accept-edits'] as const) {
			const decision = await makeHoldingResumeHandler(
				mode,
				exempt,
				{},
				'wait for the operator',
			)(bashBatch)
			expect(decision, mode).toEqual(
				mode === 'auto'
					? { action: 'approve_tools' }
					: { action: 'pause', reason: 'wait for the operator' },
			)
		}
		expect((await makeHoldingResumeHandler('strict', exempt, {}, 'x')(bashBatch)).action).toBe(
			'reject_tools',
		)
		// A path outside the roots is a person's question even under `auto`.
		const outside = {
			...(bashBatch as object),
			toolCalls: [
				{
					id: 'c2',
					name: 'read',
					input: { path: '/etc/passwd' },
					isDestructive: false,
					escalation: { outsidePaths: ['/etc/passwd'] },
				},
			],
		} as never
		expect(await makeHoldingResumeHandler('auto', () => true, {}, 'held')(outside)).toEqual({
			action: 'pause',
			reason: 'held',
		})
	})

	it('without a hold, nobody behind the handler still means approve (unchanged)', async () => {
		expect((await makeResumeHandler({ all: false }, undefined, 'prompt')(bashBatch)).action).toBe(
			'approve_tools',
		)
	})
})

describe('answering a parked scheduled turn', () => {
	it('a /resume without an answer passes no decision, the session rules and approves as before', async () => {
		const sessionRules: AuthorizationRule[] = [{ type: 'allow_by_name', toolNames: ['bash'] }]
		const session = await openSession(sessionRules)
		const decisions: string[] = []
		duringResume = async (params) => {
			decisions.push((await (params as Call).resumeHandler(bashBatch)).action)
		}
		try {
			await drain(session.resumePaused({ turnId: TURN }))
		} finally {
			await session.close()
		}
		const call = resumeCalls[0] as Call
		expect(call.pendingDecision).toBeUndefined()
		expect(call.authorizationGate.rules).toEqual(sessionRules)
		expect(decisions).toEqual(['approve_tools'])
	})

	it('applies the answer to the parked batch, gates by the job rules, and asks the operator about later calls', async () => {
		// The folder allows bash; the job says ask. The job's rules are what the resumed turn sees.
		const session = await openSession([{ type: 'allow_by_name', toolNames: ['bash'] }])
		const jobRules: AuthorizationRule[] = [
			{ type: 'custom_pattern', pattern: '^bash$', target: 'name', decision: 'review' },
		]
		const asked: unknown[] = []
		const decisions: string[] = []
		duringResume = async (params) => {
			decisions.push((await (params as Call).resumeHandler(bashBatch)).action)
		}
		try {
			await drain(
				session.resumePaused({
					turnId: TURN,
					pendingDecision: { action: 'approve_tools' },
					rules: jobRules,
					permissionMode: 'prompt',
					onPermission: async (request) => {
						asked.push(request)
						return { kind: 'reject', feedback: 'no' }
					},
				}),
			)
		} finally {
			await session.close()
		}
		const call = resumeCalls[0] as Call
		expect(call.pendingDecision).toEqual({ action: 'approve_tools' })
		expect(call.authorizationGate.rules).toEqual(jobRules)
		expect(asked).toHaveLength(1)
		expect(decisions).toEqual(['reject_tools'])
	})

	it('with a hold and nobody to ask, a later uncovered call parks again rather than running', async () => {
		const session = await openSession()
		const decisions: { action: string; reason?: string }[] = []
		duringResume = async (params) => {
			decisions.push(await (params as Call).resumeHandler(bashBatch))
		}
		try {
			await drain(
				session.resumePaused({
					turnId: TURN,
					pendingDecision: { action: 'approve_tools' },
					permissionMode: 'prompt',
					reviewHold: { reason: 'Scheduled run: waiting for the operator' },
				}),
			)
		} finally {
			await session.close()
		}
		expect(decisions).toEqual([
			{ action: 'pause', reason: 'Scheduled run: waiting for the operator' },
		])
	})
})
