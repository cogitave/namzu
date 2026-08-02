import { describe, expect, it, vi } from 'vitest'

import { buildCoordinatorTools } from '../../../tools/coordinator/index.js'
import type {
	CheckpointId,
	HITLResumeDecision,
	IterationCheckpoint,
} from '../../../types/hitl/index.js'
import type { RunId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { Logger } from '../../../utils/logger.js'
import { PendingAnswers, QuestionParkBinding } from '../question-park.js'
import { planPendingResume } from '../resume-pending.js'

/**
 * `ask_user_question` parked through the raw handler under a synthetic
 * `cp_question_<toolUseId>` id that was never written. The checkpoint
 * therefore did not exist: nothing on disk said a human owed this run an
 * answer, and a remote host could not even OBSERVE the question except
 * through the in-process callback.
 *
 * Kill the process while somebody is looking at the card and the answer
 * could never be applied — the restore path stripped the whole assistant
 * turn, discarding work sibling tools in the same batch had finished and
 * re-billing the turn.
 *
 * The re-entry half is the one that was deferred: on resume the batch is
 * re-executed, which is HOW the asking tool is re-entered, and the
 * recorded answer is handed to it instead of a second question.
 */

const RID = 'run_1' as RunId

function makeLogger(): Logger {
	const self = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger
	;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
	return self
}

const QUESTION_INPUT = {
	question: 'Which environment?',
	options: [
		{ label: 'Staging', description: 'safe' },
		{ label: 'Production', description: 'not safe' },
	],
	multiSelect: false,
	allowFreeText: true,
}

function askTool(opts: {
	resumeHandler: (request: unknown) => Promise<HITLResumeDecision>
	questionParks?: QuestionParkBinding
	pendingAnswers?: PendingAnswers
}) {
	const tools = buildCoordinatorTools({
		gateway: {} as never,
		workingDirectory: '/tmp',
		allowedAgentIds: [],
		runId: RID,
		resumeHandler: opts.resumeHandler as never,
		...(opts.questionParks ? { questionParks: opts.questionParks } : {}),
		...(opts.pendingAnswers ? { pendingAnswers: opts.pendingAnswers } : {}),
	})
	const tool = tools.find((t) => t.name === 'ask_user_question')
	if (!tool) throw new Error('ask_user_question was not built')
	return tool
}

const answer = (questionId: string): HITLResumeDecision => ({
	action: 'answer_question',
	selectedOptionIds: ['opt_1'],
	questionId,
})

describe('recording the park', () => {
	it('writes a real checkpoint and hands the tool its id', async () => {
		const recorded: string[] = []
		const parks = new QuestionParkBinding()
		parks.bind({
			record: async (q) => {
				recorded.push(q.questionId)
				return 'cp_real' as CheckpointId
			},
			resolve: async () => {},
		})

		let seenCheckpointId: string | undefined
		const tool = askTool({
			questionParks: parks,
			resumeHandler: async (request) => {
				seenCheckpointId = (request as { checkpointId: string }).checkpointId
				return answer('t1')
			},
		})

		await tool.execute(QUESTION_INPUT as never, { toolUseId: 't1' } as never)

		expect(recorded).toEqual(['t1'])
		// The synthetic id was never written anywhere, so a host given it
		// could not read the checkpoint back.
		expect(seenCheckpointId).toBe('cp_real')
	})

	it('clears the park once the answer arrives', async () => {
		const resolved: string[] = []
		const parks = new QuestionParkBinding()
		parks.bind({
			record: async () => 'cp_real' as CheckpointId,
			resolve: async (id) => {
				resolved.push(id)
			},
		})

		const tool = askTool({ questionParks: parks, resumeHandler: async () => answer('t1') })
		await tool.execute(QUESTION_INPUT as never, { toolUseId: 't1' } as never)

		// An approval queue that keeps serving an answered question is the
		// same defect the tool-review park already fixed.
		expect(resolved).toEqual(['cp_real'])
	})

	it('still asks when the park cannot be recorded', async () => {
		// An unrecorded park is a lost cross-process handoff, not a reason
		// to fail the tool — the in-process await is still perfectly valid.
		const parks = new QuestionParkBinding()
		parks.bind({ record: async () => null, resolve: async () => {} })

		const tool = askTool({ questionParks: parks, resumeHandler: async () => answer('t1') })
		const result = await tool.execute(QUESTION_INPUT as never, { toolUseId: 't1' } as never)

		expect(result.success).toBe(true)
	})

	it('is inert when nothing has bound it', async () => {
		// The tool outlives the run that binds it, so an unbound channel is
		// the normal state outside a run — and must behave exactly as it
		// did before any of this existed.
		const parks = new QuestionParkBinding()
		expect(await parks.record({ questionId: 't1' } as never)).toBeNull()
		await expect(parks.resolve('cp_x' as CheckpointId, answer('t1'))).resolves.toBeUndefined()
	})

	it('stops writing into a run that has settled', async () => {
		const parks = new QuestionParkBinding()
		parks.bind({ record: async () => 'cp_real' as CheckpointId, resolve: async () => {} })
		parks.unbind()

		expect(await parks.record({ questionId: 't1' } as never)).toBeNull()
	})
})

describe('re-entering the tool with the answer', () => {
	it('returns the carried answer without asking again', async () => {
		const handler = vi.fn(async () => answer('t1'))
		const pending = new PendingAnswers()
		pending.set('t1', answer('t1'))

		const tool = askTool({ pendingAnswers: pending, resumeHandler: handler })
		const result = await tool.execute(QUESTION_INPUT as never, { toolUseId: 't1' } as never)

		// Asking again would put a question the user already answered back
		// in front of them — and headless, would auto-answer with the
		// no-consent sentinel and throw the real answer away.
		expect(handler).not.toHaveBeenCalled()
		expect(result.success).toBe(true)
		expect(String(result.output)).toContain('Staging')
	})

	it('does not record a park for a question it already has an answer to', async () => {
		const recorded: string[] = []
		const parks = new QuestionParkBinding()
		parks.bind({
			record: async (q) => {
				recorded.push(q.questionId)
				return 'cp_real' as CheckpointId
			},
			resolve: async () => {},
		})
		const pending = new PendingAnswers()
		pending.set('t1', answer('t1'))

		const tool = askTool({
			questionParks: parks,
			pendingAnswers: pending,
			resumeHandler: async () => answer('t1'),
		})
		await tool.execute(QUESTION_INPUT as never, { toolUseId: 't1' } as never)

		// Parking an answered question leaves an outstanding record for a
		// decision that has been made.
		expect(recorded).toEqual([])
	})

	it('consumes an answer once', async () => {
		// A tool that asks the same question twice in one resumed run is
		// asking something genuinely new the second time; answering it from
		// a stale record would fabricate consent.
		const pending = new PendingAnswers()
		pending.set('t1', answer('t1'))

		expect(pending.take('t1')).toBeDefined()
		expect(pending.take('t1')).toBeUndefined()
	})

	it('falls through to a real ask for a question it has no answer to', async () => {
		const handler = vi.fn(async () => answer('t2'))
		const pending = new PendingAnswers()
		pending.set('t1', answer('t1'))

		const tool = askTool({ pendingAnswers: pending, resumeHandler: handler })
		await tool.execute(QUESTION_INPUT as never, { toolUseId: 't2' } as never)

		expect(handler).toHaveBeenCalledTimes(1)
	})

	it('carries only an answer that names its question', async () => {
		// The misdirection guard: a decision with no questionId cannot be
		// matched to a call, so it must not be delivered to whichever tool
		// happens to run next.
		const unaddressed = PendingAnswers.from({
			action: 'answer_question',
			selectedOptionIds: ['opt_1'],
		})
		expect(unaddressed.size).toBe(0)

		const approval = PendingAnswers.from({ action: 'approve_tools' })
		expect(approval.size).toBe(0)
	})
})

describe('planning the resume', () => {
	const parkedTurn = (): Message[] => [
		createUserMessage('deploy it'),
		{
			...createAssistantMessage(''),
			toolCalls: [
				{
					id: 't1',
					type: 'function' as const,
					function: { name: 'ask_user_question', arguments: '{}' },
				},
				{ id: 't2', type: 'function' as const, function: { name: 'read', arguments: '{}' } },
			],
		} as Message,
	]

	const checkpoint = (questionId: string, messages = parkedTurn()): IterationCheckpoint =>
		({
			id: 'cp_1' as CheckpointId,
			messages,
			pending: {
				parkedAt: 0,
				request: {
					type: 'user_question',
					runId: RID,
					checkpointId: 'cp_1' as CheckpointId,
					question: {
						questionId,
						question: 'Which?',
						options: [],
						multiSelect: false,
						allowFreeText: true,
					},
				},
			},
		}) as unknown as IterationCheckpoint

	it('takes over a question park instead of declining it', async () => {
		// This used to return null with "out of scope", so the restore path
		// stripped the turn and the answer was lost.
		const plan = planPendingResume(checkpoint('t1'), answer('t1'), makeLogger())

		expect(plan).not.toBeNull()
		// The whole batch is re-executed — that is how the asking tool gets
		// re-entered at all.
		expect(plan?.response.message.toolCalls).toHaveLength(2)
	})

	it('carries the answer for the call that asked', async () => {
		const plan = planPendingResume(checkpoint('t1'), answer('t1'), makeLogger())
		expect(plan?.answers?.take('t1')).toBeDefined()
	})

	it('denies nothing — a question is not an approval gate', async () => {
		const plan = planPendingResume(checkpoint('t1'), answer('t1'), makeLogger())
		expect(plan?.denials.size).toBe(0)
	})

	it('refuses an answer to a question not in this turn', async () => {
		// A stale client answering an earlier question would otherwise have
		// its answer delivered to whatever tool now holds that slot.
		const plan = planPendingResume(checkpoint('t9'), answer('t9'), makeLogger())
		expect(plan).toBeNull()
	})

	it('refuses a checkpoint whose turn is already answered', async () => {
		const answered: Message[] = [
			...parkedTurn(),
			{ role: 'tool', content: 'staging', toolCallId: 't1' } as Message,
			{ role: 'tool', content: 'read', toolCallId: 't2' } as Message,
		]
		expect(planPendingResume(checkpoint('t1', answered), answer('t1'), makeLogger())).toBeNull()
	})
})
