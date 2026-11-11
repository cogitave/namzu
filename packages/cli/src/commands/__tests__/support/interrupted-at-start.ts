import { createUserMessage, generateMessageId, generateTurnId } from '@namzu/sdk'
import {
	type CliSessions,
	openConversationLog,
	startConversation,
} from '../../../integrations/sessions/store.js'

/**
 * The journal a host leaves when it goes away in the first instant of a reply: the turn's start
 * and the person's message, and nothing after. No pause, no checkpoint, no settling record. The
 * writer lease is given back, so no live host owns the turn, unless `stillHeld` says one does
 * (a host stopped hard keeps its lease, named `namzu:<pid>:<turn>` as the kernel names it).
 */
export async function interruptedAtStart(
	state: CliSessions,
	options: { stillHeld?: boolean; holder?: (turnId: string) => string } = {},
) {
	const sessionId = await startConversation(state)
	const turnId = generateTurnId()
	const userMessageId = generateMessageId()
	const log = openConversationLog(state, sessionId)
	const lease = await log.claim({
		holder: options.holder?.(turnId) ?? 'host-that-is-gone',
		ttlMs: 5 * 60_000,
	})
	if (!lease) throw new Error('Fixture writer unavailable')
	try {
		await log.beginTurn(lease, {
			turnId,
			userMessageId,
			config: { model: 'original-model', tokenBudget: 0, timeoutMs: 0, maxIterations: 0 },
		})
		await log.append(lease, {
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			kind: 'prompt',
			content: createUserMessage('Look around the project'),
		})
	} finally {
		// A host that is still running keeps its lease; one that is gone has given it back.
		if (!options.stillHeld) await log.release(lease)
	}
	return { sessionId, turnId, log, lease }
}
