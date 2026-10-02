/** Durable Pal review reads; never an authority derived from an activity projection. */
import {
	type HITLDecisionRequest,
	type HITLResumeDecision,
	type RecordPointer,
	type SessionLog,
	type TurnId,
	asCheckpointId,
	asTurnId,
} from '@namzu/sdk'

export interface PalWaitingReview {
	readonly turnId: TurnId
	readonly checkpointId: string
	readonly decisionId: string
	readonly request: HITLDecisionRequest
	readonly requestRecord: RecordPointer
	readonly checkpointDocSha256: string
	readonly deadlineAt?: number
}

/** Read the actual strict journal, including expired parks; an expiry is a refusal. */
export async function readPalWaitingReview(
	log: SessionLog,
	turnId: string,
	checkpointId?: string,
	now = Date.now(),
): Promise<PalWaitingReview | null> {
	asTurnId(turnId)
	if (checkpointId !== undefined) asCheckpointId(checkpointId)
	const active = await log.activeTurn()
	if (active?.turnId !== turnId) throw new Error('This Pal turn is no longer waiting or active.')
	const documents = new Map<string, string>()
	const parks = new Map<string, PalWaitingReview>()
	for await (const { record, pointer } of log.read({ mode: 'strict' })) {
		if (record.sessionId !== log.sessionId) throw new Error('Foreign Pal review journal.')
		if (record.turnId !== turnId) continue
		if (record.type === 'checkpoint_written') documents.set(record.checkpointId, record.docSha256)
		else if (record.type === 'decision_requested') {
			const request = record.request as HITLDecisionRequest
			if (
				request.sessionId !== log.sessionId ||
				request.turnId !== turnId ||
				request.checkpointId !== record.checkpointId ||
				typeof record.decisionId !== 'string' ||
				!record.decisionId
			)
				throw new Error('Invalid Pal decision attribution.')
			asCheckpointId(record.checkpointId)
			const hash = documents.get(record.checkpointId)
			if (!hash) throw new Error('Pal decision has no committed checkpoint.')
			validateRequest(request)
			const deadline = record.deadlineAt === undefined ? undefined : Date.parse(record.deadlineAt)
			if (deadline !== undefined && !Number.isFinite(deadline))
				throw new Error('Invalid Pal decision deadline.')
			parks.set(record.decisionId, {
				turnId: asTurnId(turnId),
				checkpointId: record.checkpointId,
				decisionId: record.decisionId,
				request: structuredClone(request),
				requestRecord: { ...pointer },
				checkpointDocSha256: hash,
				...(deadline !== undefined ? { deadlineAt: deadline } : {}),
			})
		} else if (record.type === 'decision_resolved' || record.type === 'decision_expired')
			parks.delete(record.decisionId)
	}
	const latest = [...parks.values()].at(-1)
	if (!latest) return null
	if (checkpointId !== undefined && latest.checkpointId !== checkpointId)
		throw new Error('This Pal decision was replaced by a newer review.')
	if (latest.deadlineAt !== undefined && now >= latest.deadlineAt)
		throw new Error('This Pal decision expired.')
	return latest
}

function validateRequest(request: HITLDecisionRequest): void {
	if (request.type === 'tool_review') {
		if (
			!Array.isArray(request.toolCalls) ||
			request.toolCalls.length === 0 ||
			request.toolCalls.some(
				(call) =>
					!call ||
					typeof call.id !== 'string' ||
					!call.id ||
					typeof call.name !== 'string' ||
					!call.name ||
					typeof call.isDestructive !== 'boolean' ||
					!Object.hasOwn(call, 'input'),
			) ||
			new Set(request.toolCalls.map((call) => call.id)).size !== request.toolCalls.length
		)
			throw new Error('Invalid Pal tool review.')
	} else if (request.type === 'user_question') {
		const question = request.question
		if (
			!question ||
			typeof question.questionId !== 'string' ||
			!question.questionId ||
			!Array.isArray(question.options) ||
			typeof question.multiSelect !== 'boolean' ||
			typeof question.allowFreeText !== 'boolean' ||
			question.options.some((option) => !option || typeof option.id !== 'string' || !option.id) ||
			new Set(question.options.map((option) => option.id)).size !== question.options.length
		)
			throw new Error('Invalid Pal question review.')
	} else if (request.type !== 'iteration_checkpoint')
		throw new Error('This Pal review kind cannot be resumed durably.')
}

/** Refuse mismatched answers before acquiring a computer or calling a provider. */
export function assertPalReviewDecision(
	request: HITLDecisionRequest,
	decision: HITLResumeDecision,
): void {
	if (decision.action === 'abort' || decision.action === 'pause') {
		if (typeof decision.reason !== 'string') throw new Error('A Pal decision needs its reason.')
		return
	}
	if (request.type === 'tool_review') {
		if (!['approve_tools', 'reject_tools', 'modify_tools'].includes(decision.action))
			throw new Error('This answer does not apply to the waiting Pal tool review.')
		if (decision.action === 'reject_tools' && typeof decision.feedback !== 'string')
			throw new Error('A rejected Pal review needs its feedback.')
	} else if (request.type === 'user_question') {
		if (
			decision.action !== 'answer_question' ||
			decision.questionId !== request.question.questionId
		)
			throw new Error('This answer does not apply to the waiting Pal question.')
		const question = request.question
		if (
			!Array.isArray(decision.selectedOptionIds) ||
			decision.selectedOptionIds.some(
				(id) => !question.options.some((option) => option.id === id),
			) ||
			new Set(decision.selectedOptionIds).size !== decision.selectedOptionIds.length ||
			(!question.multiSelect && decision.selectedOptionIds.length > 1) ||
			(decision.freeText !== undefined &&
				(!question.allowFreeText || typeof decision.freeText !== 'string'))
		)
			throw new Error('Invalid answer to the waiting Pal question.')
	} else if (request.type !== 'iteration_checkpoint' || decision.action !== 'continue')
		throw new Error('This answer does not apply to the waiting Pal review.')
}
