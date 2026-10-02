import { createHash } from 'node:crypto'
import { type PalChannelActionPort, RecordPointerSchema } from '@namzu/sdk'
import {
	type CliPalReviewActionsOptions,
	type PalReviewAnswer,
	createCliPalReviewActions,
} from './actions.js'

function exactObject(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!input ||
		typeof input !== 'object' ||
		Array.isArray(input) ||
		Object.keys(input).some((key) => !keys.includes(key))
	)
		throw new Error('Invalid or unexpected authenticated channel action fields.')
	return input as Record<string, unknown>
}
function text(input: unknown, label: string): string {
	if (typeof input !== 'string' || !input || input.length > 512 || input.includes('\0'))
		throw new Error(`Invalid channel action ${label}.`)
	return input
}
function readPayload(serialized: string) {
	const payload = exactObject(JSON.parse(serialized), ['waiting', 'answer'])
	const waiting = exactObject(payload.waiting, [
		'sessionId',
		'turnId',
		'checkpointId',
		'decisionId',
		'requestKind',
		'requestRecord',
		'checkpointDocSha256',
	])
	if (
		waiting.requestKind !== 'tool_review' ||
		typeof waiting.checkpointDocSha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(waiting.checkpointDocSha256)
	)
		throw new Error('Unsupported or invalid authenticated channel review request.')
	const rawAnswer = exactObject(payload.answer, ['action', 'feedback'])
	let answer: PalReviewAnswer
	if (rawAnswer.action === 'approve_once' && !('feedback' in rawAnswer))
		answer = { action: 'approve_once' }
	else if (
		rawAnswer.action === 'reject' &&
		typeof rawAnswer.feedback === 'string' &&
		rawAnswer.feedback.length <= 4096
	)
		answer = { action: 'reject', feedback: rawAnswer.feedback }
	else throw new Error('Unsupported authenticated channel review answer.')
	return {
		waiting: {
			sessionId: text(waiting.sessionId, 'session'),
			turnId: text(waiting.turnId, 'turn'),
			checkpointId: text(waiting.checkpointId, 'checkpoint'),
			decisionId: text(waiting.decisionId, 'decision'),
			requestKind: 'tool_review' as const,
			requestRecord: RecordPointerSchema.parse(waiting.requestRecord),
			checkpointDocSha256: waiting.checkpointDocSha256,
		},
		answer,
	}
}

/** Bridges only authenticated, recorded channel actions to the real native parked-review gate. */
export function createCliPalChannelActions(
	options: CliPalReviewActionsOptions,
): PalChannelActionPort {
	const profile = Object.freeze({ ...options.profile })
	const scope = Object.freeze({ ...options.scope })
	const gate = createCliPalReviewActions({ ...options, profile, scope })
	return {
		async execute({ route, action }, signal) {
			signal.throwIfAborted()
			if (createHash('sha256').update(action.payload).digest('hex') !== action.payloadDigest)
				throw new Error('Channel action payload is no longer the authenticated payload.')
			const payload = readPayload(action.payload)
			if (
				route.context.recipient.tenantId !== scope.tenantId ||
				route.context.recipient.palId !== profile.id ||
				route.context.sessionId !== scope.sessionId ||
				route.context.profileRevision !== profile.revision ||
				payload.waiting.sessionId !== scope.sessionId ||
				payload.waiting.turnId !== route.recordedReceipt.turnId ||
				route.recordedReceipt.sessionId !== scope.sessionId
			)
				throw new Error(
					'Channel action does not belong to the exact triggering Pal conversation and turn.',
				)
			const identity = route.identity
			const operationId = createHash('sha256')
				.update(
					JSON.stringify([
						'namzu-channel-action/1',
						scope.tenantId,
						identity.provider,
						identity.connectionId,
						identity.externalTenantId,
						identity.nativeConversationId,
						identity.nativeChannelId,
						identity.nativeThreadId,
						action.eventId,
						action.actionId,
					]),
				)
				.digest('hex')
			const receipt = await gate.execute(
				{
					actor: {
						tenantId: scope.tenantId,
						actorId: route.currentActorId,
						connectionId: route.connection.connectionId,
					},
					operationId,
					waiting: { ...payload.waiting, sessionId: scope.sessionId },
					answer: payload.answer,
				},
				signal,
			)
			return {
				status: 'applied',
				receiptId: receipt.resolutionRecord.sha256,
			}
		},
	}
}
