/**
 * The one tool that turns a turn around to face the human.
 *
 * It used to be built inside `buildCoordinatorTools`, which needs a gateway,
 * a scheduler and a roster the question has no use for — so a host that
 * wanted only this tool (an interactive terminal with no delegation) had to
 * assemble the whole coordinator set and fish the question out of it, and
 * had to invent a turn id at build time because the builder demanded one.
 * This builder needs the park handler and nothing else; the turn id is read
 * from the calling `ToolContext` unless the host pins one.
 */

import { z } from 'zod'
import type { PendingAnswers, QuestionParkRecorder } from '../../runtime/query/question-park.js'
import type {
	HITLResumeDecision,
	ResumeHandler,
	UserQuestionData,
	UserQuestionItem,
	UserQuestionOption,
} from '../../types/hitl/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { generateCheckpointId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'
import { questionOptions } from './question-options.js'

/** Internal identity shared by the builder and the agent authority boundary. */
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question' as const

/**
 * The single closed shape a capable provider constrains this call to.
 *
 * `options` arriving as a STRING is the failure this exists for: a model that
 * serializes the array once tends to keep doing it, and the parse error it
 * gets back never says the array was the problem.
 * `additionalProperties: false` turns that into a refusal at generation time
 * rather than a rejection after the fact.
 */
const askUserQuestionItemModelSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		question: {
			type: 'string',
			description: 'Full question text — clear, specific, and ending with a question mark.',
		},
		header: {
			type: 'string',
			description:
				'Optional very short topic label, no more than 24 characters; unique within the call.',
		},
		options: {
			type: 'array',
			description: 'A JSON array of 2-4 genuinely distinct, context-derived option objects.',
			items: {
				type: 'object',
				properties: {
					label: {
						type: 'string',
						description:
							'Concise option label, plain text: no "(Recommended)" or other parenthesised note at the end, in any language.',
					},
					description: {
						type: 'string',
						description: 'Optional one-line explanation of what changes if selected.',
					},
					recommended: {
						type: 'boolean',
						description:
							'True on the option you recommend; put that option first. The host shows the recommendation, so never write it into the label.',
					},
					preview: {
						type: 'string',
						description:
							'Optional plain text or markdown shown beside the options while this one is focused: a snippet, a mock-up, a side-by-side. Leave it out unless it helps the choice.',
					},
				},
				required: ['label'],
				additionalProperties: false,
			},
		},
		multiSelect: {
			type: 'boolean',
			description: 'True only when several options can apply at once.',
		},
		allowFreeText: {
			type: 'boolean',
			description: 'Whether the user may answer in their own words.',
		},
	},
	required: ['question', 'options'],
	additionalProperties: false,
}

/**
 * The single closed shape a capable provider constrains this call to: a
 * `questions` array of one to four questions. The older single-question
 * input (`question` and `options` at the top level) is still accepted at
 * run time as a one-element batch, but is not offered to the model.
 */
const askUserQuestionModelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		questions: {
			type: 'array',
			description:
				'A JSON array of 1-4 questions. Batch only related decisions that all block your next step; ask a single decision as one entry.',
			items: askUserQuestionItemModelSchema,
		},
	},
	required: ['questions'],
	additionalProperties: false,
}

/** The most questions one call may carry. */
export const MAX_QUESTIONS_PER_CALL = 4

const optionSchema = z
	.object({
		label: z
			.string()
			.min(1)
			.max(80)
			.describe(
				'Concise option label (1-5 words), plain text: no "(Recommended)" or other parenthesised note at the end.',
			),
		description: z
			.string()
			.max(300)
			.optional()
			.describe('One line on what practically changes if this option is chosen.'),
		recommended: z
			.boolean()
			.optional()
			.describe(
				'True on the option you recommend; put it first. Never write the recommendation into the label.',
			),
		preview: z
			.string()
			.max(4000)
			.optional()
			.describe(
				'Optional plain text or markdown shown beside the options while this one is focused.',
			),
	})
	.strict()

const questionSchema = z
	.object({
		question: z
			.string()
			.min(1)
			.describe('Full question text — clear, specific, ends with a question mark.'),
		header: z
			.string()
			.max(24)
			.optional()
			.describe('Very short topic label for the question (e.g. "Audience", "Auth method").'),
		options: z
			.array(optionSchema)
			.min(2)
			.max(4)
			.describe('2-4 genuinely distinct, context-derived options.'),
		multiSelect: z
			.boolean()
			.optional()
			.default(false)
			.describe('True only when several options can apply at once.'),
		allowFreeText: z
			.boolean()
			.optional()
			.default(true)
			.describe('Whether the user may answer in their own words.'),
	})
	.strict()

/**
 * The old single-question input is a one-element batch. Anything that has
 * `questions` is left alone, so a call mixing both shapes fails the strict
 * object below instead of silently dropping one.
 */
function batchFromLegacy(input: unknown): unknown {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return input
	const record = input as Record<string, unknown>
	if ('questions' in record || !('question' in record)) return input
	return { questions: [record] }
}

const inputSchema = z
	.preprocess(
		batchFromLegacy,
		z
			.object({
				questions: z
					.array(questionSchema)
					.min(1)
					.max(MAX_QUESTIONS_PER_CALL)
					.describe('1-4 related questions, asked together; one answer comes back per question.'),
			})
			.strict(),
	)
	.superRefine((value, ctx) => {
		const questions = value.questions.map((q) => q.question.trim().toLowerCase())
		if (new Set(questions).size !== questions.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['questions'],
				message: 'Question texts must be unique within one call.',
			})
		}
		const headers = value.questions.flatMap((q) =>
			q.header !== undefined ? [q.header.trim().toLowerCase()] : [],
		)
		if (new Set(headers).size !== headers.length) {
			ctx.addIssue({
				code: 'custom',
				path: ['questions'],
				message:
					'Headers must be unique within one call: a host uses them as tab labels and answer keys.',
			})
		}
	})

export interface AskUserQuestionToolOptions {
	/** Where the question goes; the turn parks on it until an answer comes back. */
	resumeHandler: ResumeHandler
	/**
	 * The session and turn the park is recorded against. Omit them and the
	 * tool uses those of the call that asked, which is right in every case but
	 * a host that answers questions for a turn other than the one it drives.
	 */
	sessionId?: SessionId
	turnId?: TurnId
	/** See the same field on `CoordinatorToolsOptions`. */
	questionParks?: QuestionParkRecorder
	/** See the same field on `CoordinatorToolsOptions`. */
	pendingAnswers?: PendingAnswers
	/**
	 * The name of the tool this host mounts for approving a plan, so the
	 * description points at a tool the model has. Omit it where no such tool is
	 * mounted by name; the description then says "the plan-approval tool".
	 */
	planApprovalTool?: string
}

const NO_ANSWER_TEXT =
	'The user did not answer this question. Do not assume a choice or consent; proceed on your best judgment or continue without this information.'

const NO_ANSWER_BATCH_TEXT =
	'The user did not answer these questions. Do not assume a choice or consent; proceed on your best judgment or continue without this information.'

/** One question's answer as the tool reads it, after the host's entry is checked. */
interface ReadAnswer {
	readonly item: UserQuestionItem
	readonly selected: readonly {
		id: string
		label: string
		recommended?: true
	}[]
	readonly freeText: string
}

const isAnswered = (answer: ReadAnswer): boolean =>
	answer.selected.length > 0 || answer.freeText !== ''

/**
 * Which answer belongs to which question. `answers` is the batch form; a
 * decision without it answers the FIRST question only — the shape a host
 * that predates batches sends, and what a single-question call has always
 * received. An entry that names no question of this call, or names one
 * twice, is dropped: it was meant for something else.
 */
function readAnswers(
	items: readonly UserQuestionItem[],
	decision: Extract<HITLResumeDecision, { action: 'answer_question' }>,
): ReadAnswer[] {
	const entries =
		decision.answers ??
		(items[0]
			? [
					{
						questionId: items[0].id,
						selectedOptionIds: decision.selectedOptionIds,
						freeText: decision.freeText,
					},
				]
			: [])
	const byId = new Map<string, (typeof entries)[number]>()
	for (const entry of entries) {
		if (!byId.has(entry.questionId)) byId.set(entry.questionId, entry)
	}
	return items.map((item) => {
		const entry = byId.get(item.id)
		// The label the user saw, never a marker: `questionOptions` took it
		// out. Whether it was the recommended option is a field of its own.
		const chosen = (entry?.selectedOptionIds ?? [])
			.map((id) => item.options.find((opt) => opt.id === id))
			.filter((opt): opt is UserQuestionOption => opt !== undefined)
		const selected = (item.multiSelect ? chosen : chosen.slice(0, 1)).map((opt) => ({
			id: opt.id,
			label: opt.label,
			...(opt.recommended === true ? { recommended: true as const } : {}),
		}))
		return { item, selected, freeText: entry?.freeText?.trim() ?? '' }
	})
}

function describeSingle(answer: ReadAnswer): {
	output: string
	data: Record<string, unknown>
} {
	const { item, selected, freeText } = answer
	let output: string
	if (selected.length > 0) {
		const joined = selected.map((s) => `"${s.label}"`).join(', ')
		output = `User answered "${item.question}": ${joined}`
		if (freeText) output += `\nAdditional note from the user: "${freeText}"`
	} else {
		output = `User answered "${item.question}" in their own words: "${freeText}"`
	}
	return {
		output,
		data: {
			question: item.question,
			selected,
			...(freeText ? { freeText } : {}),
			answered: true,
		},
	}
}

const labelOf = (item: UserQuestionItem): string => item.header ?? item.question

function describeBatch(answers: readonly ReadAnswer[]): {
	output: string
	data: Record<string, unknown>
} {
	const lines = answers.map((answer) => {
		const { item, selected, freeText } = answer
		if (selected.length > 0) {
			const joined = selected.map((s) => `"${s.label}"`).join(', ')
			return `${labelOf(item)}: ${joined}${freeText ? ` (note: "${freeText}")` : ''}`
		}
		if (freeText) return `${labelOf(item)} (own words): "${freeText}"`
		return `${labelOf(item)}: not answered, assume nothing`
	})
	const answered = answers.filter(isAnswered).length
	return {
		output: `The user answered ${answered} of ${answers.length} questions:\n${lines.join('\n')}`,
		data: {
			questions: answers.map(({ item }) => ({
				questionId: item.id,
				...(item.header !== undefined ? { header: item.header } : {}),
				question: item.question,
			})),
			answers: answers.map((answer) => ({
				questionId: answer.item.id,
				...(answer.item.header !== undefined ? { header: answer.item.header } : {}),
				question: answer.item.question,
				selected: answer.selected,
				...(answer.freeText ? { freeText: answer.freeText } : {}),
				answered: isAnswered(answer),
			})),
			answered: true,
		},
	}
}

export function buildAskUserQuestionTool(config: AskUserQuestionToolOptions): ToolDefinition {
	const parkHandler = config.resumeHandler
	const { questionParks, pendingAnswers } = config
	const planApproval = config.planApprovalTool
		? `\`${config.planApprovalTool}\``
		: 'the plan-approval tool'
	return defineTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		description:
			'Ask the user when you are blocked on a decision that is genuinely theirs to make — one you cannot resolve from their request, your tools, the files you can read, or sensible defaults. The question must be the genuinely undecidable thing in THIS task. Never ask for information a tool can discover (do not ask what you can read, list, or search), never re-ask what the conversation already answers, and never ask meta-questions like "Shall I proceed?" — plan ratification goes through ' +
			planApproval +
			'. Provide 2-4 genuinely distinct options derived from the actual context — concrete paths, never generic placeholders (for example, asked to prepare a presentation, ask "Who is the audience?" with options like Board / Engineering team / Customer); keep labels short (1-5 words) and give each option a one-line description of what practically changes if it is chosen. If you recommend an option, put it FIRST and set recommended: true on it; the host marks it for the user, so never write "(Recommended)" or any translation of it into a label, and never end a label with a parenthesised note (put qualifiers in the description). Set multiSelect: true only when several options can apply at once. An option may carry a preview (plain text or markdown) that the host shows beside the list while it is focused; use it only when seeing the thing helps the choice. A free-text "Something else" escape hatch is always shown automatically — do not add your own "Other" option. Put the questions in the questions array. Use ONE entry for a single decision. Put several entries in the same call only when they are related decisions that ALL block your next step and the user can answer them together (for example which account, for what purpose, which environment before a credentialed step), at most 4, each with a short unique header; the user answers them all in one card and you get one answer per question. Never batch questions that depend on one another\'s answers — ask the first, then decide. Most work needs at most 2-3 questions in all, so prefer proceeding on stated defaults over interrogating the user. Never invent answers or synthetic content on the user\'s behalf unless they explicitly asked for a random/test scenario. The answers arrive as this tool\'s result; a question the result says was not answered must not be assumed, and if the result says the user did not answer at all, do not ask again — proceed on your best judgment without assuming consent.',
		inputSchema,
		modelInputSchema: structuredClone(askUserQuestionModelInputSchema),
		enforceModelInput: true,
		validationErrorHint:
			'Required shape: {"questions":[{"question":"...?","header":"Short","options":[{"label":"First","description":"What changes","recommended":true},{"label":"Second","description":"What changes"}]}]}. "questions" must be a JSON array of 1-4 objects. "options" must be a JSON array of 2-4 objects, never a string. Question texts and headers must be unique within one call.',
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		// MUST stay false: the executor serializes non-concurrency-safe
		// tools in a single chain, so N question blocks in one assistant
		// turn park strictly one-at-a-time. Hosts key their park/resolve
		// registries by turn — concurrent parks on one turn clobber each
		// other and the first promise never resolves (the turn hangs to TTL).
		concurrencySafe: false,
		async execute(input, context) {
			// A host that calls the tool without going through the registry
			// hands over the older single-question shape or unfilled defaults;
			// parsing again is a no-op for input the registry already parsed.
			const { questions } = inputSchema.parse(input)
			const toolUseId = context.toolUseId
			if (!toolUseId) {
				// Without the executing tool_use_id the question has no
				// stable identity: the host could never merge the awaiting
				// card with its resolution, and answers could not be matched
				// back. Hard-fail instead of parking an unmergeable id.
				return {
					success: false,
					output: '',
					error:
						'ask_user_question requires an executor that threads ToolContext.toolUseId; the question cannot be tracked without it.',
				}
			}

			// Labels without a recommendation marker, in any language, and the
			// recommendation as a field: what the host shows and what the
			// answer below quotes back to the model.
			const items: UserQuestionItem[] = questions.map((q, index) => ({
				id: `${toolUseId}#${index}`,
				question: q.question,
				...(q.header !== undefined ? { header: q.header } : {}),
				options: questionOptions(q.options),
				multiSelect: q.multiSelect,
				allowFreeText: q.allowFreeText,
			}))
			const batch = items.length > 1
			const [first] = items
			if (!first) return { success: false, output: '', error: 'No question was asked.' }

			// The top level mirrors the first question, so a host that does
			// not know `questions` still shows and answers a real question.
			const questionData: UserQuestionData = {
				questionId: toolUseId,
				question: first.question,
				...(first.header !== undefined ? { header: first.header } : {}),
				options: first.options,
				multiSelect: first.multiSelect,
				allowFreeText: first.allowFreeText,
				...(batch ? { questions: items } : {}),
			}

			// An answer carried in from a resumed turn. Checked before the
			// park, because re-entering this tool is HOW the answer gets
			// delivered: the batch is re-executed, and without this the
			// re-execution would ask the user something they already
			// answered — or, headless, auto-answer with the no-consent
			// sentinel and throw the real answer away.
			const carried = pendingAnswers?.take(toolUseId)

			// A real checkpoint, not a synthetic id nothing ever wrote.
			// Skipped when an answer is already in hand: parking a
			// question that is answered would leave an outstanding record
			// for a decision that has been made.
			const parkedAt =
				carried === undefined && questionParks ? await questionParks.record(questionData) : null

			const decision =
				carried ??
				(await parkHandler({
					type: 'user_question',
					sessionId: config.sessionId ?? context.sessionId,
					turnId: config.turnId ?? context.turnId,
					// Provider correlation ids remain verbatim in questionData;
					// an unpersisted park gets its own safe checkpoint identifier.
					checkpointId: parkedAt ?? generateCheckpointId(),
					question: questionData,
				}))

			// Clear the park once the answer is in, so an approval queue
			// stops serving a question that has been answered.
			if (parkedAt !== null && questionParks) {
				await questionParks.resolve(parkedAt, decision)
			}

			// The no-answer sentinel (explicitly NOT consent — fixes the
			// "empty answer reads as approval" ambiguity): used for empty
			// answers, misdirected legacy decisions (e.g. a stale replica
			// resolving with approve/continue verbs), and answers that
			// carry a different question's id.
			const noAnswer = {
				success: true,
				output: batch ? NO_ANSWER_BATCH_TEXT : NO_ANSWER_TEXT,
				data: batch
					? {
							question: first.question,
							questions: items.map((i) => i.question),
							answered: false,
						}
					: { question: first.question, answered: false },
			}

			if (decision.action === 'abort') {
				// One decline ends the whole batch: there is no partial refusal.
				return {
					success: false,
					output:
						'The user declined to answer and asked to stop. Acknowledge briefly and end your turn.',
					data: { question: first.question, answered: false, declined: true },
				}
			}

			if (decision.action !== 'answer_question') return noAnswer
			if (decision.questionId !== undefined && decision.questionId !== toolUseId) {
				// Misdirection guard: this answer was meant for a different
				// question parked under the same turn (stale client). Never
				// fabricate a selection against the wrong question.
				return noAnswer
			}

			const answers = readAnswers(items, decision)
			if (!answers.some(isAnswered)) return noAnswer

			const described = batch ? describeBatch(answers) : describeSingle(answers[0] as ReadAnswer)
			return { success: true, output: described.output, data: described.data }
		},
	})
}
