import { randomUUID } from 'node:crypto'
import {
	SKILL_SAVE_OPTIONS,
	SKILL_SAVE_QUESTION_ID,
	skillSaveCardPayload,
} from '../skills/save-card.js'
import type { SaveSkillAnswer, SaveSkillHost } from '../skills/save.js'
import type { QuestionAnswer, QuestionFn, UserQuestion } from '../tui/agent.js'
import { browserWindowQuestionApp, screenQuestionApp } from '../tui/computer-use-screen-approval.js'

/**
 * How a question the agent puts to the person reaches the desktop and comes back. The shared
 * protocol bridge has one request a client answers (a yes or a no to a batch of calls), and an
 * answer to "which of these?" is not one. So the host says the question as a `namzu/`
 * notification, the desktop answers it with an extension call, and a question nobody can
 * answer any more (the turn stopped, the tool gave up waiting) is told closed.
 */
/** A question Desktop draws as its own approval card rather than as a question. */
const cardQuestion = (question: { readonly questionId: string; readonly question: string }) =>
	screenQuestionApp(question) !== undefined || browserWindowQuestionApp(question) !== undefined

export const QUESTION_NOTIFICATION = 'namzu/session/question'
export const QUESTION_CLOSED_NOTIFICATION = 'namzu/session/question-closed'
export const ANSWER_QUESTION_METHOD = 'namzu/session/answer-question'

const MAX_IDS = 64
const MAX_ID_LENGTH = 200
const MAX_TEXT = 10_000

type Notify = (method: string, params: Record<string, unknown>) => void

interface Pending {
	readonly sessionId: string
	/** One question with no `questions` list: the kernel reads its answer from the top level. */
	readonly single: boolean
	readonly settle: (answer: QuestionAnswer) => void
}

export interface QuestionRelay {
	/** The question channel of one turn of one conversation. */
	forTurn(sessionId: string, turnSignal: AbortSignal): QuestionFn
	/**
	 * The person's answer to an open question. Returns whether a question was waiting for it: an
	 * answer to one that closed, or to another conversation's, changes nothing.
	 */
	answer(sessionId: string, requestId: string, answer: unknown): boolean
	/**
	 * The `save_skill` confirmation of one conversation, drawn as the skill-save card. It is not a
	 * permission request and no permission mode answers it: only the person's own pick of a place
	 * saves, and every other outcome (cancel, an answer that does not read, the turn stopping, a
	 * closed stream) is a cancel.
	 */
	skillSaveConfirm(sessionId: string, cwd: () => string): SaveSkillHost['confirm']
}

const ids = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value) || value.length > MAX_IDS) return undefined
	const out: string[] = []
	for (const item of value) {
		if (typeof item !== 'string' || item.length === 0 || item.length > MAX_ID_LENGTH)
			return undefined
		out.push(item)
	}
	return out
}

const note = (value: unknown): string | undefined | null => {
	if (value === undefined) return undefined
	if (typeof value !== 'string' || value.length > MAX_TEXT) return null
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

/**
 * What the desktop sent, read as an answer, or `undefined` when it is not one. Nothing here is
 * taken on trust: an answer that does not read is not a yes, it is no answer at all.
 */
export function readQuestionAnswer(value: unknown): QuestionAnswer | undefined {
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Record<string, unknown>
	if (record.kind === 'skip') return { kind: 'skip' }
	if (record.kind === 'abort') return { kind: 'abort' }
	if (record.kind !== 'answer') return undefined
	const selected = ids(record.selectedOptionIds ?? [])
	const freeText = note(record.freeText)
	if (!selected || freeText === null) return undefined
	let answers: { questionId: string; selectedOptionIds: string[]; freeText?: string }[] | undefined
	if (record.answers !== undefined) {
		if (!Array.isArray(record.answers) || record.answers.length > MAX_IDS) return undefined
		answers = []
		for (const entry of record.answers) {
			if (typeof entry !== 'object' || entry === null) return undefined
			const item = entry as Record<string, unknown>
			const itemIds = ids(item.selectedOptionIds ?? [])
			const itemText = note(item.freeText)
			if (
				typeof item.questionId !== 'string' ||
				item.questionId.length === 0 ||
				item.questionId.length > MAX_ID_LENGTH ||
				!itemIds ||
				itemText === null
			)
				return undefined
			answers.push({
				questionId: item.questionId,
				selectedOptionIds: itemIds,
				...(itemText !== undefined ? { freeText: itemText } : {}),
			})
		}
	}
	return {
		kind: 'answer',
		selectedOptionIds: selected,
		...(freeText !== undefined ? { freeText } : {}),
		...(answers ? { answers } : {}),
	}
}

/** The place the person picked on the skill-save card; anything else is no pick. */
export function pickedSkillTarget(answer: QuestionAnswer): SaveSkillAnswer {
	if (answer.kind !== 'answer') return 'cancel'
	const entry = answer.answers?.find((item) => item.questionId === SKILL_SAVE_QUESTION_ID)
	const picked = entry ? entry.selectedOptionIds : answer.answers ? [] : answer.selectedOptionIds
	return picked.length === 1 && (picked[0] === 'user' || picked[0] === 'project')
		? picked[0]
		: 'cancel'
}

/**
 * A lone question is answered at the top level (`selectedOptionIds`, `freeText`); the card names
 * its one question in a list, so the entry is lifted out of it.
 */
function asSingleAnswer(answer: QuestionAnswer): QuestionAnswer {
	if (answer.kind !== 'answer' || !answer.answers) return answer
	const first = answer.answers[0]
	return {
		kind: 'answer',
		selectedOptionIds: first?.selectedOptionIds ?? [],
		...(first?.freeText !== undefined ? { freeText: first.freeText } : {}),
	}
}

/**
 * The relay of a desktop host. A question is held until the desktop answers it, or until the turn
 * (or the caller waiting on it) stops: then it is closed on the desktop too, so a card never
 * stays up for a question nothing can use. A turn that stops is `abort`; a caller that merely
 * stopped waiting is `skip`.
 */
export function createQuestionRelay(notify: Notify): QuestionRelay {
	const open = new Map<string, Pending>()
	const say = (method: string, params: Record<string, unknown>) => {
		try {
			notify(method, params)
		} catch {
			/* A closed stream cannot show a question; the turn's own stop ends the wait. */
		}
	}
	return {
		forTurn(sessionId, turnSignal) {
			return (question: UserQuestion, signal?: AbortSignal) =>
				new Promise<QuestionAnswer>((resolve) => {
					if (turnSignal.aborted) return resolve({ kind: 'abort' })
					if (signal?.aborted) return resolve({ kind: 'skip' })
					// A screen question has its own card; it never reaches here by this channel.
					if (cardQuestion(question)) return resolve({ kind: 'skip' })
					const requestId = randomUUID()
					let done = false
					const finish = (answer: QuestionAnswer, tell: boolean) => {
						if (done) return
						done = true
						open.delete(requestId)
						turnSignal.removeEventListener('abort', onTurn)
						signal?.removeEventListener('abort', onCaller)
						if (tell) say(QUESTION_CLOSED_NOTIFICATION, { sessionId, requestId })
						resolve(answer)
					}
					const onTurn = () => finish({ kind: 'abort' }, true)
					const onCaller = () => finish({ kind: 'skip' }, true)
					open.set(requestId, {
						sessionId,
						single: question.questions === undefined,
						settle: (answer) => finish(answer, false),
					})
					turnSignal.addEventListener('abort', onTurn, { once: true })
					signal?.addEventListener('abort', onCaller, { once: true })
					say(QUESTION_NOTIFICATION, { sessionId, requestId, question })
				})
		},
		skillSaveConfirm(sessionId, cwd) {
			return (request, signal) =>
				new Promise<SaveSkillAnswer>((resolve) => {
					if (signal?.aborted) return resolve('cancel')
					const requestId = randomUUID()
					let done = false
					const finish = (answer: SaveSkillAnswer, tell: boolean) => {
						if (done) return
						done = true
						open.delete(requestId)
						signal?.removeEventListener('abort', onAbort)
						if (tell) say(QUESTION_CLOSED_NOTIFICATION, { sessionId, requestId })
						resolve(answer)
					}
					const onAbort = () => finish('cancel', true)
					open.set(requestId, {
						sessionId,
						single: false,
						settle: (answer) => finish(pickedSkillTarget(answer), false),
					})
					signal?.addEventListener('abort', onAbort, { once: true })
					say(QUESTION_NOTIFICATION, {
						sessionId,
						requestId,
						question: {
							questions: [
								{
									id: SKILL_SAVE_QUESTION_ID,
									header: 'Save skill',
									question: `Save the skill "${request.draft.name}"?`,
									options: [
										{ id: SKILL_SAVE_OPTIONS[0], label: 'Save to my skills' },
										{ id: SKILL_SAVE_OPTIONS[1], label: 'Save to this project' },
										{ id: SKILL_SAVE_OPTIONS[2], label: 'Cancel' },
									],
									multiSelect: false,
									allowFreeText: false,
								},
							],
						},
						skillSave: skillSaveCardPayload(request, cwd()),
					})
				})
		},
		answer(sessionId, requestId, answer) {
			const pending = open.get(requestId)
			if (!pending || pending.sessionId !== sessionId) return false
			const read = readQuestionAnswer(answer)
			if (!read) return false
			pending.settle(pending.single ? asSingleAnswer(read) : read)
			return true
		},
	}
}

/**
 * One question function out of the two a desktop conversation has: the "screen needed for a
 * moment" question keeps its own card over the permission request, every other question goes to
 * the person through the relay. Either may be absent.
 */
export function routeQuestions(
	screen: QuestionFn | undefined,
	relay: QuestionFn | undefined,
): QuestionFn | undefined {
	if (!screen) return relay
	if (!relay) return screen
	return (question, signal) =>
		cardQuestion(question) ? screen(question, signal) : relay(question, signal)
}
