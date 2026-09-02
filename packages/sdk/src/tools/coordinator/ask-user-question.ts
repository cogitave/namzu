/**
 * The one tool that turns a run around to face the human.
 *
 * It used to be built inside `buildCoordinatorTools`, which needs a gateway,
 * a scheduler and a roster the question has no use for — so a host that
 * wanted only this tool (an interactive terminal with no delegation) had to
 * assemble the whole coordinator set and fish the question out of it, and
 * had to invent a run id at build time because the builder demanded one.
 * This builder needs the park handler and nothing else; the run id is read
 * from the calling `ToolContext` unless the host pins one.
 */

import { z } from 'zod'
import type { PendingAnswers, QuestionParkRecorder } from '../../runtime/query/question-park.js'
import type { ResumeHandler, UserQuestionOption } from '../../types/hitl/index.js'
import type { RunId } from '../../types/ids/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { asCheckpointId } from '../../utils/id.js'
import { defineTool } from '../defineTool.js'

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
const askUserQuestionModelInputSchema: Record<string, unknown> = {
	type: 'object',
	properties: {
		question: {
			type: 'string',
			description: 'Full question text — clear, specific, and ending with a question mark.',
		},
		header: {
			type: 'string',
			description: 'Optional very short topic label, no more than 24 characters.',
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
							'Concise option label. Put the recommended option first and append " (Recommended)".',
					},
					description: {
						type: 'string',
						description: 'Optional one-line explanation of what changes if selected.',
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

export interface AskUserQuestionToolOptions {
	/** Where the question goes; the run parks on it until an answer comes back. */
	resumeHandler: ResumeHandler
	/**
	 * The run the park is recorded against. Omit it and the tool uses the
	 * `runId` of the call that asked, which is the right run in every case
	 * but a host that answers questions for a run other than the one it drives.
	 */
	runId?: RunId
	/** See the same field on `CoordinatorToolsOptions`. */
	questionParks?: QuestionParkRecorder
	/** See the same field on `CoordinatorToolsOptions`. */
	pendingAnswers?: PendingAnswers
}

export function buildAskUserQuestionTool(config: AskUserQuestionToolOptions): ToolDefinition {
	const parkHandler = config.resumeHandler
	const { questionParks, pendingAnswers } = config
	return defineTool({
		name: ASK_USER_QUESTION_TOOL_NAME,
		description:
			'Ask the user ONE question ONLY when you are blocked on a decision that is genuinely theirs to make — one you cannot resolve from their request, your tools, the files you can read, or sensible defaults. The question must be the genuinely undecidable thing in THIS task. Never ask for information a tool can discover (do not ask what you can read, list, or search), never re-ask what the conversation already answers, and never ask meta-questions like "Shall I proceed?" — plan ratification goes through approve_plan. Provide 2-4 genuinely distinct options derived from the actual context — concrete paths, never generic placeholders (for example, asked to prepare a presentation, ask "Who is the audience?" with options like Board / Engineering team / Customer); keep labels short (1-5 words) and give each option a one-line description of what practically changes if it is chosen. Put your recommended option FIRST and append " (Recommended)" to its label. Set multiSelect: true only when several options can apply at once. A free-text "Something else" escape hatch is always shown automatically — do not add your own "Other" option. Ask ONE question per call and prefer at most one question per assistant turn; if several decisions block you, ask only the ones that materially change your next actions, in sequence — most work needs at most 2-3 questions, so prefer proceeding on stated defaults over interrogating the user. Never invent answers or synthetic content on the user\'s behalf unless they explicitly asked for a random/test scenario. The answer arrives as this tool\'s result; if the result says the user did not answer, do not ask this or any other question again — proceed on your best judgment without assuming consent.',
		inputSchema: z
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
					.array(
						z
							.object({
								label: z
									.string()
									.min(1)
									.max(80)
									.describe(
										'Concise option label (1-5 words). Recommended option goes first with " (Recommended)" appended.',
									),
								description: z
									.string()
									.max(300)
									.optional()
									.describe('One line on what practically changes if this option is chosen.'),
							})
							.strict(),
					)
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
			.strict(),
		modelInputSchema: structuredClone(askUserQuestionModelInputSchema),
		enforceModelInput: true,
		validationErrorHint:
			'Required shape: {"question":"...?","options":[{"label":"First (Recommended)","description":"What changes"},{"label":"Second","description":"What changes"}]}. "options" must be a JSON array of 2-4 objects, never a string.',
		category: 'custom',
		permissions: [],
		readOnly: true,
		destructive: false,
		// MUST stay false: the executor serializes non-concurrency-safe
		// tools in a single chain, so N question blocks in one assistant
		// turn park strictly one-at-a-time. Hosts key their park/resolve
		// registries by runId — concurrent parks on one run clobber each
		// other and the first promise never resolves (run hangs to TTL).
		concurrencySafe: false,
		async execute({ question, header, options, multiSelect, allowFreeText }, context) {
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

			const questionOptions: UserQuestionOption[] = options.map((opt, i) => ({
				id: `opt_${i + 1}`,
				label: opt.label,
				...(opt.description !== undefined ? { description: opt.description } : {}),
			}))

			const questionData = {
				questionId: toolUseId,
				question,
				...(header !== undefined ? { header } : {}),
				options: questionOptions,
				multiSelect,
				allowFreeText,
			}

			// An answer carried in from a resumed run. Checked before the
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
					runId: config.runId ?? context.runId,
					checkpointId: parkedAt ?? asCheckpointId(`cp_question_${toolUseId}`),
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
				output:
					'The user did not answer this question. Do not assume a choice or consent; proceed on your best judgment or continue without this information.',
				data: { question, answered: false },
			}

			if (decision.action === 'abort') {
				return {
					success: false,
					output:
						'The user declined to answer and asked to stop. Acknowledge briefly and end your turn.',
					data: { question, answered: false, declined: true },
				}
			}

			if (decision.action !== 'answer_question') return noAnswer
			if (decision.questionId !== undefined && decision.questionId !== toolUseId) {
				// Misdirection guard: this answer was meant for a different
				// question parked under the same run (stale client). Never
				// fabricate a selection against the wrong question.
				return noAnswer
			}

			const stripRecommended = (label: string) =>
				label.replace(/\s*\(recommended\)\s*$/i, '').trim()

			const selected = decision.selectedOptionIds
				.map((id) => questionOptions.find((opt) => opt.id === id))
				.filter((opt): opt is UserQuestionOption => opt !== undefined)
				.map((opt) => ({ id: opt.id, label: stripRecommended(opt.label) }))

			const freeText = decision.freeText?.trim() ?? ''

			if (selected.length === 0 && !freeText) return noAnswer

			let output: string
			if (selected.length > 0) {
				const joined = selected.map((s) => `"${s.label}"`).join(', ')
				output = `User answered "${question}": ${joined}`
				if (freeText) {
					output += `\nAdditional note from the user: "${freeText}"`
				}
			} else {
				output = `User answered "${question}" in their own words: "${freeText}"`
			}

			return {
				success: true,
				output,
				data: {
					question,
					selected,
					...(freeText ? { freeText } : {}),
					answered: true,
				},
			}
		},
	})
}
