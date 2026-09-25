import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import {
	InMemorySessionTokenBudgetStore,
	SessionTokenBudget,
	type SessionTokenBudgetScope,
	openSessionTokenBudget,
} from '../../../store/budget/index.js'
import type { TokenUsage } from '../../../types/common/index.js'
import { autoApproveHandler } from '../../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Checkpoint } from '../../../types/session/checkpoint.js'
import { generateCheckpointId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import { resolveQueryBudget } from '../token-budget.js'
import type { TurnStateScope } from '../turn-state.js'
import { type CheckpointedSession, TEST_SCOPE, sessionWithCheckpoint } from './support/session.js'

const directories: string[] = []
afterEach(async () => {
	await removeTempDirs(directories.splice(0))
})

function usage(tokens: number): TokenUsage {
	return {
		promptTokens: tokens,
		completionTokens: 0,
		totalTokens: tokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
}

/**
 * A root turn's ledger (keyed by its session and turn) in a store that
 * outlives the process, and the resume parameters for that turn.
 */
async function fixture(limit = 1_000) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-ledger-resume-'))
	directories.push(workingDirectory)
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	const rootScope: SessionTokenBudgetScope = { rootSessionId: sessionId, rootTurnId: turnId }
	const store = new InMemorySessionTokenBudgetStore()
	const root = await openSessionTokenBudget({ store, scope: rootScope, limit })
	const scope: TurnStateScope = { ...TEST_SCOPE, sessionId, turnId }
	const provider = new MockLLMProvider({ turns: [{ text: 'continued', usage: usage(50) }] })
	const base = {
		...scope,
		provider,
		toolsets: [],
		resumeHandler: autoApproveHandler,
		tokenBudgetStore: store,
		workingDirectory,
		retry: false as const,
		agentId: 'resume-budget',
		agentName: 'Resume budget',
		turnConfig: { model: 'mock', timeoutMs: 30_000, tokenBudget: 1_000, maxIterations: 4 },
	}
	return { workingDirectory, rootScope, root, store, scope, provider, base }
}

/**
 * The interrupted turn: its log with a committed checkpoint that says
 * `tokens` were spent and names `budget`'s account.
 */
function interrupted(
	budget: SessionTokenBudget,
	scope: { readonly sessionId: SessionId; readonly turnId: TurnId },
	tokens: number,
	document: Partial<Checkpoint> = {},
): Promise<CheckpointedSession> {
	return sessionWithCheckpoint({
		sessionId: scope.sessionId,
		turnId: scope.turnId,
		messages: [createUserMessage('Continue the saved work.')],
		document: {
			iteration: 1,
			tokenUsage: usage(tokens),
			guards: { iteration: 1, elapsedMs: 1 },
			budget: {
				...(budget.binding ? { binding: budget.binding } : {}),
				accountId: budget.accountId,
			},
			...document,
		},
		release: true,
	})
}

function resumeParams(
	f: Awaited<ReturnType<typeof fixture>>,
	session: CheckpointedSession,
	scope: TurnStateScope = f.scope,
): ResumeSessionParams {
	return {
		...f.base,
		...scope,
		scope,
		sessionLog: session.log,
		checkpointStore: session.store,
	}
}

describe('checkpoint resume keeps the latest token authority', () => {
	it('reopens an unlimited turn after long elapsed time without losing measured spend', async () => {
		const f = await fixture(0)
		f.root.recordUsage(usage(300_000))
		await f.root.flush()
		const session = await interrupted(f.root, f.scope, 300_000, {
			iteration: 500,
			guards: { iteration: 500, elapsedMs: 24 * 60 * 60 * 1000 },
		})
		const outcome = await resumeSession({
			...resumeParams(f, session),
			turnConfig: { model: 'mock', tokenBudget: 0, maxIterations: 0, timeoutMs: 0 },
		})
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(outcome.turn.stopReason).toBe('end_turn')
		expect(f.provider.requests).toHaveLength(1)
		expect(outcome.turn.budget).toMatchObject({
			limit: 0,
			ownTokens: 300_050,
			treeTokens: 300_050,
			remainingTokens: null,
		})
		const reopened = await openSessionTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.summary()).toMatchObject({
			limit: 0,
			ownTokens: 300_050,
			remainingTokens: null,
		})
	})

	it('applies a narrower turn cap to a supplied root authority', async () => {
		const f = await fixture()
		const resolved = await resolveQueryBudget(
			{
				...f.base,
				budget: f.root,
				messages: [],
				turnConfig: { ...f.base.turnConfig, tokenBudget: 100 },
			},
			f.scope.turnId,
			f.store,
		)
		await resolved.flush()
		expect(resolved).toBe(f.root)
		expect(resolved.limit).toBe(100)
		const reopened = await openSessionTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.limit).toBe(100)
	})

	it('restores the checkpoint without rolling back newer parent or child spending', async () => {
		const f = await fixture()
		f.root.recordUsage(usage(100))
		const session = await interrupted(f.root, f.scope, 100)
		f.root.recordUsage(usage(300))
		const child = f.root.reserve(400)
		child.bindTurn(generateSessionId(), generateTurnId())
		child.recordUsage(usage(200))
		child.settle()
		await f.root.flush()
		const outcome = await resumeSession(resumeParams(f, session))
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(1)
		expect(outcome.turn.tokenUsage.totalTokens).toBe(350)
		expect(outcome.turn.budget?.treeTokens).toBe(550)
		const reopened = await openSessionTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.ownTokens).toBe(350)
		expect(reopened.treeTokens).toBe(550)
	})

	it('reopens a child against its root ledger and original child grant', async () => {
		const f = await fixture()
		f.root.recordUsage(usage(200))
		const child = f.root.reserve(400)
		const childScope: TurnStateScope = {
			...f.scope,
			sessionId: generateSessionId(),
			turnId: generateTurnId(),
			parentSessionId: f.scope.sessionId,
			parentTurnId: f.scope.turnId,
		}
		child.bindTurn(childScope.sessionId, childScope.turnId)
		child.recordUsage(usage(100))
		const session = await interrupted(child, childScope, 100)
		child.recordUsage(usage(250))
		await f.root.flush()
		const outcome = await resumeSession({
			...resumeParams(f, session, childScope),
			turnConfig: { ...f.base.turnConfig, tokenBudget: 400 },
		})
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(1)
		expect(outcome.turn.tokenUsage.totalTokens).toBe(300)
		const reopened = await openSessionTokenBudget({
			store: f.store,
			scope: f.rootScope,
			requireExisting: true,
		})
		expect(reopened.ownTokens).toBe(200)
		expect(reopened.treeTokens).toBe(500)
	})

	it('makes no provider call when newer durable spending already exhausts the root', async () => {
		const f = await fixture()
		const session = await interrupted(f.root, f.scope, 100)
		f.root.recordUsage(usage(1_000))
		await f.root.flush()
		const outcome = await resumeSession(resumeParams(f, session))
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) throw new Error('resume unexpectedly refused')
		expect(f.provider.requests).toHaveLength(0)
		expect(outcome.turn.stopReason).toBe('token_budget')
		expect(outcome.turn.tokenUsage.totalTokens).toBe(1_000)
	})

	it('requires current authority for a checkpoint made with an in-memory account', async () => {
		const f = await fixture()
		const current = SessionTokenBudget.create(1_000, f.rootScope)
		current.recordUsage(usage(150))
		const session = await interrupted(current, f.scope, 100)
		await expect(resumeSession(resumeParams(f, session))).rejects.toThrow(
			'current authoritative budget',
		)
		expect(f.provider.requests).toHaveLength(0)
		// The refusal left the turn as it was: resumable once the host hands
		// the authority over.
		const result = await resumeSession({ ...resumeParams(f, session), budget: current })
		expect(result.resumed).toBe(true)
		expect(current.ownTokens).toBe(200)
	})

	it('refuses a supplied account from a different root before spending', async () => {
		const f = await fixture()
		const session = await interrupted(f.root, f.scope, 0)
		const other = SessionTokenBudget.create(1_000, {
			rootSessionId: generateSessionId(),
			rootTurnId: generateTurnId(),
		})
		await expect(resumeSession({ ...resumeParams(f, session), budget: other })).rejects.toThrow()
		expect(f.provider.requests).toHaveLength(0)
	})

	it('does not create a ledger while resolving a missing checkpoint', async () => {
		const f = await fixture()
		const session = await interrupted(f.root, f.scope, 0)
		const fresh: TurnStateScope = { ...f.scope, turnId: generateTurnId() }
		const outcome = await resumeSession({
			...resumeParams(f, session, fresh),
			checkpointId: generateCheckpointId(),
		})
		expect(outcome).toEqual({ resumed: false, reason: 'no-checkpoint' })
		expect(
			await f.store.load({ rootSessionId: fresh.sessionId, rootTurnId: fresh.turnId }),
		).toBeNull()
		expect(f.provider.requests).toHaveLength(0)
	})
})
