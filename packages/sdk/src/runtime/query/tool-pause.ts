import type { HITLResumeDecision, ResumeHandler, UserQuestionData } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { RequestToolPause, ToolPauseRequest } from '../../types/tool/index.js'
import type { PendingAnswers, QuestionParkRecorder } from './question-park.js'

/**
 * The durable pause, made reachable from any tool.
 *
 * The machinery was excellent and reachable from exactly four
 * kernel-owned points: the plan gate, the tool-review gate, the iteration
 * cadence, and one built-in question tool. A host-authored tool — the
 * spend, the outbound post, the destructive migration, the operations
 * that most want their OWN confirmation with their OWN wording — had no
 * seam to it. The only route was to hand-thread a recorder and a resume
 * callback into a private tool builder, mirroring what the coordinator
 * does, and nothing in the type a tool author is handed suggested that
 * was possible.
 *
 * This is that same machinery behind a function on `ToolContext`. Nothing
 * new is invented: the park is a real checkpoint, the answer routes back
 * on resume, and a pause is inert outside a run that supports one.
 */

/**
 * Identity of one pause.
 *
 * `<toolUseId>:<name>` rather than the tool-use id alone, because the id
 * identifies the CALL and a call may pause more than once — "which
 * environment" then "are you sure". Keying on the call would make the
 * second answer arrive against the first question. The name is the tool
 * author's, so a resume payload can name what it is answering.
 */
export const pauseId = (toolUseId: string, name: string): string => `${toolUseId}:${name}`

interface ToolPauseDeps {
	readonly runId: RunId
	readonly toolUseId: string
	readonly parkHandler: ResumeHandler
	readonly recorder?: QuestionParkRecorder
	readonly pendingAnswers?: PendingAnswers
}

function toQuestion(request: ToolPauseRequest, id: string): UserQuestionData {
	return {
		questionId: id,
		question: request.prompt,
		...(request.header !== undefined ? { header: request.header } : {}),
		options: (request.options ?? []).map((option) => ({
			id: option.id,
			label: option.label,
			...(option.description !== undefined ? { description: option.description } : {}),
		})),
		multiSelect: request.multiSelect ?? false,
		allowFreeText: request.allowFreeText ?? true,
	}
}

/**
 * An unanswered pause is NOT consent.
 *
 * The same rule the built-in question tool follows, and for the same
 * reason: a tool that pauses to ask "may I charge this card" and reads
 * silence as yes is worse than one that never asked.
 */
const unanswered = (reason: string) => ({ status: 'unanswered' as const, reason })

export function createToolPause(deps: ToolPauseDeps): RequestToolPause {
	return async (request) => {
		const id = pauseId(deps.toolUseId, request.name)

		// An answer carried in from a resumed run, checked BEFORE parking.
		// Re-entering the tool is how the answer gets delivered — the batch
		// re-executes — so without this the resume would ask a human
		// something they already answered, or headlessly discard it.
		const carried = deps.pendingAnswers?.take(id)

		const question = toQuestion(request, id)
		const parkedAt =
			carried === undefined && deps.recorder ? await deps.recorder.record(question) : null

		const decision: HITLResumeDecision =
			carried ??
			(await deps.parkHandler({
				type: 'user_question',
				runId: deps.runId,
				checkpointId: parkedAt ?? `cp_pause_${id}`,
				question,
			}))

		if (parkedAt !== null && deps.recorder) {
			await deps.recorder.resolve(parkedAt, decision)
		}

		if (decision.action === 'abort') return { status: 'aborted' }
		if (decision.action !== 'answer_question') {
			return unanswered('the pause was resolved without an answer')
		}
		if (decision.questionId !== undefined && decision.questionId !== id) {
			// Misdirection guard. Host queues are keyed by run, so a stale
			// client can answer pause N after pause N+1 opened under the same
			// run. Answering the wrong question is worse than not answering.
			return unanswered('the answer was addressed to a different pause')
		}

		const known = new Set((request.options ?? []).map((option) => option.id))
		const selectedOptionIds = decision.selectedOptionIds.filter((selected) => known.has(selected))
		const freeText = decision.freeText

		if (selectedOptionIds.length === 0 && (freeText === undefined || freeText.length === 0)) {
			return unanswered('the answer selected nothing and said nothing')
		}

		return {
			status: 'answered',
			selectedOptionIds,
			...(freeText !== undefined && freeText.length > 0 ? { text: freeText } : {}),
		}
	}
}
