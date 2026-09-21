import {
	type Message,
	type SessionId,
	type TurnId,
	generateCheckpointId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'

import {
	type CliSessions,
	openConversationLog,
	refreshIndex,
} from '../integrations/sessions/store.js'

/**
 * Record one settled turn into a conversation's log the way the kernel's turn
 * recorder does: `turn_started`, one `message` record per message, then
 * `turn_completed`. Tests use it to give a conversation history without
 * running a model; the CLI itself never writes these records.
 */
export async function recordTurn(
	s: Pick<CliSessions, 'paths' | 'slug' | 'index'>,
	sessionId: SessionId,
	messages: readonly Message[],
	options: {
		readonly turnId?: TurnId
		readonly result?: string
		readonly status?: 'completed' | 'cancelled' | 'failed' | 'paused'
		readonly originKind?: 'prompt' | 'goal-round' | 'resident-step' | 'verification'
	} = {},
): Promise<TurnId> {
	const log = openConversationLog(s, sessionId)
	const lease = await log.claim({ holder: `test:${process.pid}:${Math.random()}`, ttlMs: 30_000 })
	if (!lease) throw new Error(`recordTurn: session ${sessionId} is leased by another writer`)
	const turnId = options.turnId ?? generateTurnId()
	try {
		const ids = messages.map(() => generateMessageId())
		const userIndex = messages.findIndex((message) => message.role === 'user')
		await log.beginTurn(lease, {
			turnId,
			userMessageId: ids[userIndex >= 0 ? userIndex : 0] ?? generateMessageId(),
			config: { model: 'test-model', tokenBudget: 100_000, timeoutMs: 600_000 },
			...(options.originKind ? { origin: { protocol: 'cli', kind: options.originKind } } : {}),
		})
		for (const [index, message] of messages.entries()) {
			await log.append(lease, {
				type: 'message',
				turnId,
				messageId: ids[index] ?? generateMessageId(),
				role: message.role,
				...(message.role === 'user' && index === userIndex ? { kind: 'prompt' as const } : {}),
				content: message,
			})
		}
		const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
		const result =
			options.result ?? (typeof assistant?.content === 'string' ? assistant.content : '')
		const settlement = {
			iterations: 1,
			usage: {
				promptTokens: 10,
				completionTokens: 5,
				totalTokens: 15,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			durationMs: 1,
			resultSource: 'model' as const,
			abandonedTaskIds: [],
			abandonedJobIds: [],
		}
		const status = options.status ?? 'completed'
		if (status === 'failed') {
			await log.append(lease, {
				type: 'turn_failed',
				turnId,
				error: result || 'failed',
				settlement: { ...settlement, status: 'failed' },
			})
		} else if (status === 'paused') {
			// A parked turn stays open; the caller supplies no checkpoint document.
			await log.append(lease, {
				type: 'turn_paused',
				turnId,
				reason: 'awaiting a decision',
				checkpointId: generateCheckpointId(),
			})
		} else {
			await log.append(lease, {
				type: 'turn_completed',
				turnId,
				result,
				...(status === 'cancelled' ? { stopReason: 'cancelled' as const } : {}),
				settlement: { ...settlement, status },
			})
		}
	} finally {
		await log.release(lease)
	}
	await refreshIndex(s, sessionId)
	return turnId
}
