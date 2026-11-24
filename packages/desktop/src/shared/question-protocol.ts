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

/**
 * A skill the agent drafted, for the person to save or not: the host sends it with the question
 * whose three options (`user`, `project`, `cancel`) answer it. The host computed every field.
 */
export interface SkillSaveCard {
	name: string
	description: string
	/** The whole file, with invisible characters shown as `<U+XXXX>`. */
	file: string
	hiddenCharacters: boolean
	warnings: string[]
	suggested: 'user' | 'project'
	/** User first, project second. */
	targets: { scope: 'user' | 'project'; path: string; shadows: string[] }[]
	shadowsExisting: boolean
}

/** The id of the question a skill-save card answers, and its options. */
export const SKILL_SAVE_QUESTION_ID = 'skill-save'
export type SkillSaveChoice = 'user' | 'project' | 'cancel'

export interface QuestionNotice {
	sessionId: string
	requestId: string
	questions: QuestionItem[]
	skillSave?: SkillSaveCard
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

const MAX_SKILL_FILE = 200_000

const flag = (value: unknown): value is boolean => typeof value === 'boolean'

const lines = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value) || value.length > 24) return undefined
	return value.every((item) => typeof item === 'string' && item.length <= 600)
		? (value as string[])
		: undefined
}

/** The skill-save card a host sent, or `undefined` when any part of it does not read. */
export function readSkillSaveCard(value: unknown): SkillSaveCard | undefined {
	if (!record(value)) return undefined
	const name = text(value.name, 64)
	const description = text(value.description, 1024)
	const file =
		typeof value.file === 'string' && value.file.length <= MAX_SKILL_FILE ? value.file : ''
	const warnings = lines(value.warnings)
	const suggested =
		value.suggested === 'project' ? 'project' : value.suggested === 'user' ? 'user' : ''
	if (!name || !description || !file.trim() || !warnings || !suggested) return undefined
	if (!flag(value.hiddenCharacters) || !flag(value.shadowsExisting)) return undefined
	if (!Array.isArray(value.targets) || value.targets.length !== 2) return undefined
	const targets: SkillSaveCard['targets'] = []
	for (const [index, entry] of value.targets.entries()) {
		if (!record(entry)) return undefined
		const scope = index === 0 ? 'user' : 'project'
		const path = text(entry.path, 1000)
		const shadows = lines(entry.shadows)
		if (entry.scope !== scope || !path || !shadows) return undefined
		targets.push({ scope, path, shadows })
	}
	return {
		name,
		description,
		file,
		hiddenCharacters: value.hiddenCharacters,
		warnings,
		suggested,
		targets,
		shadowsExisting: value.shadowsExisting,
	}
}

export function readQuestionNotice(params: unknown): QuestionNotice | undefined {
	if (!record(params)) return undefined
	const sessionId = id(params.sessionId)
	const requestId = id(params.requestId)
	const questions = readQuestionItems(params.question)
	if (!sessionId || !requestId || !questions) return undefined
	// A skill-save card that does not read is no card at all: the whole request is dropped, so the
	// host (which is waiting) is told "skipped", which saving reads as a cancel.
	if (params.skillSave !== undefined) {
		const skillSave = readSkillSaveCard(params.skillSave)
		return skillSave ? { sessionId, requestId, questions, skillSave } : undefined
	}
	return { sessionId, requestId, questions }
}

/**
 * Who asked, when the question itself does not read (too long, too many options). The host is
 * holding a promise for it, so the app answers that it was skipped instead of saying nothing.
 */
export function readQuestionNoticeIds(
	params: unknown,
): { sessionId: string; requestId: string } | undefined {
	if (!record(params)) return undefined
	const sessionId = id(params.sessionId)
	const requestId = id(params.requestId)
	return sessionId && requestId ? { sessionId, requestId } : undefined
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
