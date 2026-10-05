import {
	type Checkpoint,
	DiskSessionCheckpointStore,
	DiskSessionTokenBudgetStore,
	type SessionRecordDraft,
	SessionTokenBudget,
	createUserMessage,
	generateCheckpointId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'
import { sessionLogCheckpointView } from '../../../integrations/sessions/checkpoint-view.js'
import {
	type CliSessions,
	openConversationLog,
	startConversation,
} from '../../../integrations/sessions/store.js'

/** Real durable fixture: no provider call and no wall-clock outcome guard. */
export async function providerPaused(
	state: CliSessions,
	options: {
		unresolved?: boolean
		poisoned?: boolean
		limit?: number
		pause?: Partial<Extract<SessionRecordDraft, { type: 'turn_paused' }>>
		withCheckpoint?: boolean
	} = {},
) {
	const sessionId = await startConversation(state)
	const turnId = generateTurnId()
	const checkpointId = generateCheckpointId()
	const userMessageId = generateMessageId()
	const log = openConversationLog(state, sessionId)
	const lease = await log.claim({ holder: 'provider-retry-test', ttlMs: 60_000 })
	if (!lease) throw new Error('Fixture writer unavailable')
	const scope = { tenantId: state.tenantId, projectId: state.projectId, sessionId, turnId }
	const budgetScope = { rootSessionId: sessionId, rootTurnId: turnId }
	const budgets = new DiskSessionTokenBudgetStore({ paths: state.paths })
	const budget = SessionTokenBudget.create(options.limit ?? 0, budgetScope, {
		save: (snapshot) => budgets.save(budgetScope, snapshot),
	})
	const requestId = await budget.beginRequest()
	const usage = {
		promptTokens: 4,
		completionTokens: 2,
		totalTokens: 6,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	}
	if (options.unresolved) await budget.failRequest(requestId)
	else await budget.finishRequest(requestId, usage)
	const snapshot = budget.snapshot()
	if (options.poisoned) snapshot.poisoned = true
	await budgets.save(budgetScope, snapshot)
	try {
		await log.beginTurn(lease, {
			turnId,
			userMessageId,
			config: {
				model: 'original-model',
				tokenBudget: options.limit ?? 0,
				timeoutMs: 0,
				maxIterations: 0,
			},
			budget: budget.binding,
		})
		const user = createUserMessage('Continue the original robot task')
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: user,
		})
		const head = await log.head()
		const binding = budget.binding
		if (!head || !binding)
			throw new Error('Fixture checkpoint has no durable head or budget binding')
		const checkpoint: Checkpoint = {
			v: 1,
			kind: 'checkpoint',
			checkpointId,
			sessionId,
			turnId,
			iteration: 1,
			throughSeq: head.pointer.seq,
			throughSha256: head.pointer.sha256,
			tokenUsage: usage,
			costInfo: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			budget: { binding, accountId: budget.accountId },
			guards: { iteration: 1, elapsedMs: 0 },
			review: { structuredAttempts: 0, answerAttempts: 0, nativeStructuredAttempts: 0 },
			latestUserMessageId: userMessageId,
			turnCreatedAt: '2026-10-05T09:00:00.000Z',
			createdAt: '2026-10-05T09:00:01.000Z',
		}
		if (options.withCheckpoint !== false) {
			const store = new DiskSessionCheckpointStore({
				paths: state.paths,
				log: sessionLogCheckpointView(log),
			})
			const receipt = await store.write(scope, checkpoint)
			await log.append(lease, { type: 'checkpoint_written', turnId, ...receipt })
		}
		await log.append(lease, {
			type: 'turn_paused',
			turnId,
			checkpointId,
			reason: 'Provider temporarily unavailable',
			failure: { code: 'network', message: 'Provider temporarily unavailable', retryable: true },
			providerError: { kind: 'network', providerId: 'zen' },
			...options.pause,
		})
	} finally {
		await log.release(lease)
	}
	return { sessionId, turnId, checkpointId, log, scope, budgetScope }
}
