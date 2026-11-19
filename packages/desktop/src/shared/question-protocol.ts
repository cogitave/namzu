/**
 * A question the agent puts to the person, and the answer back. The desktop half of
 * `packages/cli/src/commands/acp-desktop-question.ts`: the host says a question as the
 * notification `namzu/session/question`, the person answers it in a card, the answer goes back
 * as the extension call `namzu/session/answer-question`, and a question nobody can answer any
 * more is told closed by `namzu/session/question-closed`.
 *
 * Inside the app a question travels as a waiting request of the conversation, so the status mark,
 * the "needs you" count and the notices read it like any other request that waits for the person.
 * Its one call is named `QUESTION_TOOL` (`conversation-status.ts`) and its input is `{ questions: QuestionItem[] }`.
 */
export const QUESTION_NOTIFICATION = 'namzu/session/question'
export const QUESTION_CLOSED_NOTIFICATION = 'namzu/session/question-closed'
export const ANSWER_QUESTION_METHOD = 'namzu/session/answer-question'

export interface QuestionOption {
	/** Positional (`opt_1`, `opt_2`, ...); an answer names options by it. */
	id: string
	label: string
	description?: string
	/** Present (true) only on an option the model recommends. */
	recommended?: true
	/** Plain text or markdown shown beside the option while it is focused. */
	preview?: string
}

export interface QuestionItem {
	id: string
	question: string
	header?: string
	options: QuestionOption[]
	multiSelect: boolean
	allowFreeText: boolean
}

export interface QuestionNotice {
	sessionId: string
	requestId: string
	questions: QuestionItem[]
}

export interface QuestionClosedNotice {
	sessionId: string
	requestId: string
}

/** What the person did with a question card. */
export type QuestionResponse =
	| {
			kind: 'answer'
			/** One entry per question the person answered; a question left alone has none. */
			answers: { questionId: string; selectedOptionIds: string[]; freeText?: string }[]
	  }
	/** "I would rather not answer": the turn goes on and the model is told nobody answered. */
	| { kind: 'skip' }
	/** Stop asking and stop the turn. */
	| { kind: 'abort' }

const MAX_ID = 200
const MAX_QUESTIONS = 12
const MAX_OPTIONS = 24
const MAX_QUESTION = 2_000
const MAX_HEADER = 120
const MAX_LABEL = 300
const MAX_DESCRIPTION = 1_000
const MAX_PREVIEW = 4_000
/** What the person may write in their own words, in one answer. */
export const QUESTION_TEXT_MAX = 4_000

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: unknown, max: number): string | undefined =>
	typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined

const id = (value: unknown): string | undefined => text(value, MAX_ID)

function readOption(value: unknown): QuestionOption | undefined {
	if (!record(value)) return undefined
	const optionId = id(value.id)
	const label = text(value.label, MAX_LABEL)
	if (!optionId || !label) return undefined
	const description = text(value.description, MAX_DESCRIPTION)
	const preview = text(value.preview, MAX_PREVIEW)
	return {
		id: optionId,
		label,
		...(description ? { description } : {}),
		...(value.recommended === true ? { recommended: true as const } : {}),
		...(preview ? { preview } : {}),
	}
}

function readItem(value: unknown, fallbackId: string): QuestionItem | undefined {
	if (!record(value)) return undefined
	const question = text(value.question, MAX_QUESTION)
	if (!question || !Array.isArray(value.options) || value.options.length > MAX_OPTIONS)
		return undefined
	const options = value.options.map(readOption)
	if (options.some((option) => option === undefined)) return undefined
	const header = text(value.header, MAX_HEADER)
	return {
		id: id(value.id) ?? fallbackId,
		question,
		...(header ? { header } : {}),
		options: options as QuestionOption[],
		multiSelect: value.multiSelect === true,
		allowFreeText: value.allowFreeText !== false,
	}
}

/**
 * The questions a host sent, as a list: a batch (`questions`) as it is, a single question as a
 * list of one whose id is the question's own. `undefined` when none of it reads.
 */
export function readQuestionItems(value: unknown): QuestionItem[] | undefined {
	if (!record(value)) return undefined
	const raw = Array.isArray(value.questions) ? value.questions : undefined
	if (raw) {
		if (raw.length === 0 || raw.length > MAX_QUESTIONS) return undefined
		const items = raw.map((entry, index) => readItem(entry, `${index}`))
		return items.every((item) => item !== undefined) ? (items as QuestionItem[]) : undefined
	}
	const single = readItem(value, id(value.questionId) ?? '0')
	return single ? [single] : undefined
}

export function readQuestionNotice(params: unknown): QuestionNotice | undefined {
	if (!record(params)) return undefined
	const sessionId = id(params.sessionId)
	const requestId = id(params.requestId)
	const questions = readQuestionItems(params.question)
	return sessionId && requestId && questions ? { sessionId, requestId, questions } : undefined
}

export function readQuestionClosedNotice(params: unknown): QuestionClosedNotice | undefined {
	if (!record(params)) return undefined
	const sessionId = id(params.sessionId)
	const requestId = id(params.requestId)
	return sessionId && requestId ? { sessionId, requestId } : undefined
}

/** The answer a window sent, checked. Throws a sentence a person can read. */
export function readQuestionResponse(value: unknown): QuestionResponse {
	if (!record(value)) throw new Error('Invalid answer.')
	if (value.kind === 'skip' || value.kind === 'abort') return { kind: value.kind }
	if (
		value.kind !== 'answer' ||
		!Array.isArray(value.answers) ||
		value.answers.length > MAX_QUESTIONS
	)
		throw new Error('Invalid answer.')
	const answers: { questionId: string; selectedOptionIds: string[]; freeText?: string }[] = []
	for (const entry of value.answers) {
		if (!record(entry)) throw new Error('Invalid answer.')
		const questionId = id(entry.questionId)
		const selected = entry.selectedOptionIds
		if (
			!questionId ||
			!Array.isArray(selected) ||
			selected.length > MAX_OPTIONS ||
			selected.some((item) => typeof item !== 'string' || !item || item.length > MAX_ID)
		)
			throw new Error('Invalid answer.')
		if (entry.freeText !== undefined && typeof entry.freeText !== 'string')
			throw new Error('Invalid answer.')
		if (typeof entry.freeText === 'string' && entry.freeText.length > QUESTION_TEXT_MAX)
			throw new Error(
				`Keep an answer under ${QUESTION_TEXT_MAX.toLocaleString('en-US')} characters.`,
			)
		const freeText = typeof entry.freeText === 'string' ? entry.freeText.trim() : ''
		answers.push({
			questionId,
			selectedOptionIds: [...(selected as string[])],
			...(freeText ? { freeText } : {}),
		})
	}
	return { kind: 'answer', answers }
}
