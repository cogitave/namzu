import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type {
	CheckpointId,
	HITLDecisionRequest,
	HITLResumeDecision,
	IterationCheckpoint,
} from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createAssistantMessage, createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import type { ToolPauseOutcome } from '../../../types/tool/index.js'
import type { Logger } from '../../../utils/logger.js'
import { drainQuery } from '../index.js'
import { PendingAnswers, QuestionParkBinding } from '../question-park.js'
import { planPendingResume } from '../resume-pending.js'
import { resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'
import { pauseId } from '../tool-pause.js'

/**
 * A pause raised through `ToolContext.requestPause` could not be resumed
 * across a process, and the machinery it needs was all present and correct.
 *
 * Three breaks, all of them the same shape — a capability whose writer and
 * whose reader can both be named, with no road between them:
 *
 *  1. The gate. `createToolPause` parks under `<toolUseId>:<name>` and the
 *     resume gate compared that against a raw tool-call id, so it could
 *     never open. Every durable resume of a general-seam pause logged "The
 *     parked question does not belong to any unanswered call in this turn"
 *     and fell through to the repair that strips the turn.
 *  2. No recorder. The seam only got one when the host passed
 *     `questionParks`, and `SupervisorAgent` is the only caller in the
 *     repository that does. `QuestionParkBinding` is not public, so no host
 *     could pass one — the pause wrote no checkpoint at all.
 *  3. No answer channel. `pendingAnswers` had exactly the same shape, so the
 *     recorded answer could not be handed back to the re-entered tool.
 *
 * The narrow path — the built-in `ask_user_question`, which parks under the
 * bare tool-use id and is handed both objects by `SupervisorAgent` — worked
 * throughout, which is why this shipped. `durable-question-park.test.ts`
 * covers that path and passes against the unfixed code; every case here is
 * about the general one.
 */

registerMock()

const SCOPE: RunStateScope = {
	tenantId: 'tnt_pause' as TenantId,
	projectId: 'prj_pause' as ProjectId,
	sessionId: 'ses_pause' as SessionId,
	runId: 'run_pause' as RunId,
	topicId: 'thd_pause' as ThreadId,
}

const PAUSE = {
	name: 'target_environment',
	prompt: 'which environment should this run against?',
	options: [
		{ id: 'staging', label: 'Staging' },
		{ id: 'production', label: 'Production' },
	],
}

/** The id `createToolPause` mints for {@link PAUSE} on call `call_1`. */
const PAUSED_ON_CALL_1 = pauseId('call_1', PAUSE.name)

const answerWith = (questionId: string, option: string): HITLResumeDecision => ({
	action: 'answer_question',
	questionId,
	selectedOptionIds: [option],
})

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-tool-pause-resume-'))
	workdirs.push(dir)
	return dir
}

describe('the resume gate, on the id the general seam actually parks under', () => {
	function makeLogger(): Logger {
		const self = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as Logger
		;(self as { child: (ctx: unknown) => Logger }).child = vi.fn(() => self)
		return self
	}

	const parkedTurn = (): Message[] => [
		createUserMessage('deploy it'),
		{
			...createAssistantMessage(''),
			toolCalls: [
				{ id: 'call_1', type: 'function' as const, function: { name: 'deploy', arguments: '{}' } },
				{ id: 'call_2', type: 'function' as const, function: { name: 'read', arguments: '{}' } },
			],
		} as Message,
	]

	const checkpoint = (questionId: string): IterationCheckpoint =>
		({
			id: 'cp_1' as CheckpointId,
			messages: parkedTurn(),
			pending: {
				parkedAt: 0,
				request: {
					type: 'user_question',
					runId: SCOPE.runId,
					checkpointId: 'cp_1' as CheckpointId,
					question: {
						questionId,
						question: PAUSE.prompt,
						options: [],
						multiSelect: false,
						allowFreeText: true,
					},
				},
			},
		}) as unknown as IterationCheckpoint

	it('takes over a pause parked under <toolUseId>:<name>', () => {
		// The whole defect in one assertion. `call_1:target_environment` is
		// what is on disk, `call_1` is what is in the turn, and equality
		// between them returned null here — so the answer a human had already
		// given was discarded and the turn stripped.
		const plan = planPendingResume(
			checkpoint(PAUSED_ON_CALL_1),
			answerWith(PAUSED_ON_CALL_1, 'staging'),
			makeLogger(),
		)

		expect(plan).not.toBeNull()
		// The whole batch is re-executed, which is HOW the asking tool is
		// re-entered at all.
		expect(plan?.response.message.toolCalls).toHaveLength(2)
	})

	it('carries the answer under the full pause id, not the call id', () => {
		// Routing stays keyed on the whole composite: the tool asks
		// `PendingAnswers` for `call_1:target_environment`, so filing the
		// answer under `call_1` would leave it unreachable.
		const plan = planPendingResume(
			checkpoint(PAUSED_ON_CALL_1),
			answerWith(PAUSED_ON_CALL_1, 'staging'),
			makeLogger(),
		)

		expect(plan?.answers?.take(PAUSED_ON_CALL_1)).toBeDefined()
		expect(plan?.answers?.take('call_1')).toBeUndefined()
	})

	it('still takes over the bare id the built-in question tool parks under', () => {
		// The preservation case. The narrow path was the only one that ever
		// worked and it has to keep working.
		const plan = planPendingResume(
			checkpoint('call_1'),
			answerWith('call_1', 'staging'),
			makeLogger(),
		)

		expect(plan).not.toBeNull()
		expect(plan?.answers?.take('call_1')).toBeDefined()
	})

	it('still refuses a pause raised from a call that is not in this turn', () => {
		// Widening the match must not widen it to everything: a stale client
		// answering an earlier turn would otherwise have its answer delivered
		// to whatever tool now holds that slot.
		const stale = pauseId('call_9', PAUSE.name)

		expect(
			planPendingResume(checkpoint(stale), answerWith(stale, 'staging'), makeLogger()),
		).toBeNull()
	})
})

describe('a pause raised from a host-authored tool survives the process', () => {
	/**
	 * A tool that parks on its own question, recording what the seam handed
	 * back so the test can read it from outside the run.
	 */
	function deployTool(seen: { outcome?: ToolPauseOutcome }): ToolRegistry {
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'deploy',
				description: 'deploy tool',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute: async (_input, context) => {
					seen.outcome = await context.requestPause?.(PAUSE)
					return { success: true, output: `pause: ${seen.outcome?.status ?? 'no seam'}` }
				},
			}),
		)
		return tools
	}

	async function baseParams(store: InMemoryCheckpointStore) {
		return {
			checkpointStore: store,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_pause',
			agentName: 'Pause Agent',
			workingDirectory: await mkWorkdir(),
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
		}
	}

	/**
	 * Run the tool once, far enough that its pause is recorded, and leave the
	 * park outstanding.
	 *
	 * The checkpoint is entirely the run's own — its messages, its tool-call
	 * ids and, the part that matters, the `questionId` `createToolPause`
	 * actually minted. Only `resolvedAt` is stripped afterwards, which is
	 * precisely what a process killed between `record` and `resolve` leaves
	 * behind: the human was still looking at the card. Simulating the kill
	 * this way rather than by aborting mid-await keeps the test from being
	 * one that can hang, which is a result that is not a result.
	 *
	 * Nothing here passes `questionParks` or `pendingAnswers`. That is the
	 * point: neither type is public, so no host can, and before this change
	 * the store came back empty from this function.
	 */
	async function parkOnce(store: InMemoryCheckpointStore): Promise<IterationCheckpoint> {
		const seen: { outcome?: ToolPauseOutcome } = {}

		await drainQuery({
			...(await baseParams(store)),
			runId: SCOPE.runId,
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
					{ text: 'deployed' },
				],
			}),
			tools: deployTool(seen),
			messages: [{ role: 'user', content: 'deploy it' }],
			// Nobody answers: this stands in for the process that went away
			// while the question was on somebody's screen.
			resumeHandler: async () => ({ action: 'continue' }) as HITLResumeDecision,
		} as never)

		const parked = (await store.listCheckpoints(SCOPE)).find(
			(cp) => cp.pending?.request.type === 'user_question',
		)
		if (!parked?.pending) {
			throw new Error('the pause recorded no checkpoint, so there is nothing to resume from')
		}

		const { resolvedAt: _neverArrived, ...outstanding } = parked.pending
		const stillParked = { ...parked, pending: outstanding } as IterationCheckpoint
		await store.writeCheckpoint(SCOPE, stillParked)
		return stillParked
	}

	it('records a durable park with no host-supplied recorder', async () => {
		const store = new InMemoryCheckpointStore()
		const parked = await parkOnce(store)

		// Break 2. Without the run's own binding this wrote nothing at all,
		// so a host queue had no question to show and a resume had no
		// checkpoint to find — the pause was an in-process `await` and
		// nothing said so.
		expect(parked.pending?.request.type).toBe('user_question')
	})

	it('parks under the composite id, which is what makes the gate matter', async () => {
		const store = new InMemoryCheckpointStore()
		const parked = await parkOnce(store)
		const request = parked.pending?.request

		// Asserted from the durable record rather than from `pauseId`, so
		// this stays true about what is ON DISK and not about the helper.
		expect(request?.type === 'user_question' && request.question.questionId).toBe(
			'call_1:target_environment',
		)
	})

	it('delivers the answer to the re-entered tool in a fresh runtime', async () => {
		const store = new InMemoryCheckpointStore()
		const parked = await parkOnce(store)
		const request = parked.pending?.request
		const questionId = request?.type === 'user_question' ? request.question.questionId : ''

		// A second runtime: new provider, new registry, new tool instance,
		// nothing carried in memory from the run that parked. The store and
		// the decision are the only things that cross.
		const seen: { outcome?: ToolPauseOutcome } = {}
		const asked = vi.fn()

		const outcome = await resumeRun({
			...(await baseParams(store)),
			scope: SCOPE,
			provider: new MockLLMProvider({ turns: [{ text: 'deployed' }] }),
			tools: deployTool(seen),
			pendingDecision: answerWith(questionId, 'staging'),
			resumeHandler: async (request: HITLDecisionRequest) => {
				asked(request.type)
				return { action: 'continue' } as HITLResumeDecision
			},
		} as never)

		expect(outcome.resumed).toBe(true)
		// The consequence that cannot happen without every hop: the tool was
		// re-entered, its pause found the recorded answer, and the option a
		// human chose came back to the tool that asked.
		expect(seen.outcome).toEqual({ status: 'answered', selectedOptionIds: ['staging'] })
		// And it was not asked a second time. Re-asking would put a question
		// the user already answered back in front of them, and headless would
		// resolve it with the no-consent sentinel.
		expect(asked).not.toHaveBeenCalledWith('user_question')
	})

	it('binds the recorder the host supplied, and releases it when the run settles', async () => {
		// The run owning a fallback must not mean the run ignoring the host.
		// `SupervisorAgent`'s built-in question tool closed over THIS object
		// before the run existed, so a run that quietly bound its own instead
		// would stop recording that tool's parks — and every test of that
		// tool builds the coordinator directly, so none of them would notice.
		//
		// Written because the mutation "the run ignores a host-supplied
		// recorder" survived the whole suite.
		const parks = new QuestionParkBinding()
		const bind = vi.spyOn(parks, 'bind')
		const unbind = vi.spyOn(parks, 'unbind')

		await drainQuery({
			...(await baseParams(new InMemoryCheckpointStore())),
			runId: SCOPE.runId,
			questionParks: parks,
			provider: new MockLLMProvider({ turns: [{ text: 'nothing to deploy' }] }),
			tools: new ToolRegistry(),
			messages: [{ role: 'user', content: 'status' }],
			resumeHandler: async () => ({ action: 'continue' }) as HITLResumeDecision,
		} as never)

		expect(bind).toHaveBeenCalledTimes(1)
		// Released on the way out, so a later run cannot write into a
		// finished one through the same object.
		expect(unbind).toHaveBeenCalledTimes(1)
	})

	it('reads a carried answer out of the channel the host supplied', async () => {
		// The other half of the same rule, and the same mutation survived it:
		// a run that answers only out of its own channel strands every answer
		// a host filled in before calling.
		const answers = new PendingAnswers()
		answers.set(PAUSED_ON_CALL_1, answerWith(PAUSED_ON_CALL_1, 'production'))

		const seen: { outcome?: ToolPauseOutcome } = {}
		const asked = vi.fn()

		await drainQuery({
			...(await baseParams(new InMemoryCheckpointStore())),
			runId: SCOPE.runId,
			pendingAnswers: answers,
			provider: new MockLLMProvider({
				turns: [
					{ toolCalls: [{ id: 'call_1', name: 'deploy', args: {} }], finishReason: 'tool_calls' },
					{ text: 'deployed' },
				],
			}),
			tools: deployTool(seen),
			messages: [{ role: 'user', content: 'deploy it' }],
			resumeHandler: async (request: HITLDecisionRequest) => {
				asked(request.type)
				return { action: 'continue' } as HITLResumeDecision
			},
		} as never)

		expect(seen.outcome).toEqual({ status: 'answered', selectedOptionIds: ['production'] })
		expect(asked).not.toHaveBeenCalledWith('user_question')
	})

	it('refuses an answer addressed to a pause this turn never raised', async () => {
		const store = new InMemoryCheckpointStore()
		await parkOnce(store)

		const seen: { outcome?: ToolPauseOutcome } = {}

		await resumeRun({
			...(await baseParams(store)),
			scope: SCOPE,
			provider: new MockLLMProvider({ turns: [{ text: 'deployed' }] }),
			tools: deployTool(seen),
			// A stale client answering some other run's question. The widened
			// gate must not have widened into accepting this.
			pendingDecision: answerWith(pauseId('call_7', PAUSE.name), 'production'),
			resumeHandler: async () => ({ action: 'continue' }) as HITLResumeDecision,
		} as never)

		expect(seen.outcome?.status).not.toBe('answered')
	})
})
