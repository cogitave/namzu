import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest } from '../../../types/hitl/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import { generateTurnId } from '../../../utils/id.js'
import { type RecordedPark, findPendingCheckpoint, readParks } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeSessionParams, resumeSession } from '../resume-session.js'
import type { TurnStateScope } from '../turn-state.js'
import { heldCheckpointStore, memorySession, sessionWithCheckpoint } from './support/session.js'

/**
 * A decision the runtime cannot apply must leave the park alone, and the
 * existing tests never looked.
 *
 * The refusal itself is asserted elsewhere — the run completes and the tool
 * does not execute. What nothing checked is the durable consequence: the
 * park is still on the record afterwards, because the human's answer was
 * never carried out. Clearing it would be worse than leaving it: an approval
 * queue that forgets a request nobody answered shows a run with no way
 * forward, while a park left standing is exactly what
 * `findPendingCheckpoint` exists to serve.
 */

function freshScope() {
	const session = memorySession()
	const scope: TurnStateScope = {
		turnId: generateTurnId(),
		tenantId: session.tenantId,
		projectId: session.projectId,
		sessionId: session.sessionId,
		topicId: session.topicId,
	}
	return { session, scope }
}

const RUN_CONFIG = {
	model: 'mock-model',
	timeoutMs: 30_000,
	tokenBudget: 100_000,
	maxIterations: 4,
	maxResponseTokens: 256,
}

const gate = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-refused-plan-'))
	dirs.push(dir)
	return dir
}

/** A destructive call the gate sends to a human, recording every execution. */
function deployRegistry(executions: string[]): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(
		defineTool({
			name: 'deploy',
			description: 'a destructive call that needs a human',
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: false,
			destructive: true,
			concurrencySafe: false,
			execute: async () => {
				executions.push('deploy')
				return { success: true, output: 'deployed' }
			},
		}),
	)
	return tools
}

describe('a resume whose decision the runtime cannot apply', () => {
	/** Park a destructive call on a review and answer "not now". */
	async function parkOnReview(
		{ session, scope }: ReturnType<typeof freshScope>,
		executions: string[],
	) {
		const workingDirectory = await workdir()
		await drainQuery(
			{
				provider: new MockLLMProvider({
					turns: [
						{
							toolCalls: [{ id: 'call_deploy', name: 'deploy', args: {} }],
							finishReason: 'tool_calls',
						},
					],
				}),
				tools: deployRegistry(executions),
				...session,
				agentId: 'agent_refused_plan',
				agentName: 'Refused plan agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				turnId: scope.turnId,
				authorizationGate: gate,
				resumeHandler: async (request: HITLDecisionRequest) =>
					request.type === 'tool_review'
						? { action: 'pause', reason: 'let me look at that' }
						: { action: 'continue' },
				turnConfig: RUN_CONFIG,
			} as unknown as QueryParams,
			(_event: SessionEvent) => {},
		)
		return workingDirectory
	}

	/** The resume a host would issue for the parked turn. */
	function resumeParams(
		{ session, scope }: ReturnType<typeof freshScope>,
		extra: Record<string, unknown>,
	): Promise<ResumeSessionParams> {
		return heldCheckpointStore(session.sessionLog).then(
			(checkpointStore) =>
				({
					scope,
					sessionLog: session.sessionLog,
					checkpointStore,
					sessionId: scope.sessionId,
					topicId: scope.topicId,
					projectId: scope.projectId,
					tenantId: scope.tenantId,
					agentId: 'agent_refused_plan',
					agentName: 'Refused plan agent',
					authorizationGate: gate,
					turnConfig: RUN_CONFIG,
					...extra,
				}) as unknown as ResumeSessionParams,
		)
	}

	/** Every park of the turn, answered or not. */
	async function parksOf(session: ReturnType<typeof freshScope>['session']) {
		return readParks(session.sessionLog)
	}

	it('still finds the park afterwards, because nothing was carried out', async () => {
		const target = freshScope()
		const executions: string[] = []
		const workingDirectory = await parkOnReview(target, executions)

		expect(executions).toEqual([])
		const reviewPark = (await findPendingCheckpoint(target.session.sessionLog)) as RecordedPark
		expect(reviewPark?.pending.request.type).toBe('tool_review')

		// `continue` does not describe what to do with a batch of pending tool
		// calls — `planPendingResume` says so and returns null rather than
		// guessing at an approval.
		const resumed = await resumeSession(
			await resumeParams(target, {
				pendingDecision: { action: 'continue' },
				provider: new MockLLMProvider({ turns: [{ text: 'never mind, I will ask again' }] }),
				tools: deployRegistry(executions),
				workingDirectory,
			}),
		)

		expect(resumed.resumed).toBe(true)

		// Nothing was executed — the decision did not authorize anything.
		expect(executions).toEqual([])

		// And the park is STILL outstanding. The decision was never carried
		// out, so the request is still owed an answer; an approval queue that
		// had this cleared for it would show the run as having nothing left to
		// do, when in fact it is waiting on the same question it was before.
		const stillPending = await findPendingCheckpoint(target.session.sessionLog)
		expect(stillPending?.checkpointId).toBe(reviewPark.checkpointId)
		expect(stillPending?.pending.resolvedAt).toBeUndefined()
	})

	it('still records the decision itself when the decision IS applied', async () => {
		// The control for the case above, and the guard on the fix that changed
		// it: a decision that DID reach the calls it named must still be
		// recorded as itself. A discriminator that labelled the applied case as
		// superseded would satisfy the case above and fail this one, and the
		// record would then no longer say who approved what — the one thing an
		// approval gate's evidence exists for. This case passes before and
		// after that fix; it is here to keep the fix from over-reaching.
		const target = freshScope()
		const executions: string[] = []
		const workingDirectory = await parkOnReview(target, executions)
		const reviewPark = (await findPendingCheckpoint(target.session.sessionLog)) as RecordedPark

		// The session log is complete evidence that the parked call never
		// started, so `planPendingResume` applies the decision.
		const resumed = await resumeSession(
			await resumeParams(target, {
				pendingDecision: { action: 'approve_tools' },
				provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
				tools: deployRegistry(executions),
				workingDirectory,
			}),
		)

		expect(resumed.resumed).toBe(true)
		// The approval was CARRIED OUT: the call the human approved ran.
		expect(executions).toEqual(['deploy'])

		expect(await findPendingCheckpoint(target.session.sessionLog)).toBeNull()
		const recorded = (await parksOf(target.session)).find(
			(park) => park.checkpointId === reviewPark.checkpointId,
		)
		expect(recorded?.pending.resolvedAt).toBeGreaterThan(0)
		expect(recorded?.pending.decision).toEqual({ action: 'approve_tools' })
	})
})

describe('a partially-applied tool batch', () => {
	it('is not resumed as though its unanswered calls had completed', async () => {
		const workingDirectory = await workdir()
		const executions: string[] = []

		// The shape a crash leaves: the assistant asked for two calls, one came
		// back, and the process died. The log records that the first started
		// and completed; nothing says the second started, and the log itself
		// says the turn began — so its absence is proof.
		const crashed = await sessionWithCheckpoint({
			messages: [
				{ role: 'user', content: 'do both' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'call_one', type: 'function', function: { name: 'first', arguments: '{}' } },
						{ id: 'call_two', type: 'function', function: { name: 'second', arguments: '{}' } },
					],
				},
				{ role: 'tool', content: 'first came back', toolCallId: 'call_one' },
			],
			release: true,
		})

		const tools = new ToolRegistry()
		for (const name of ['first', 'second']) {
			tools.register(
				defineTool({
					name,
					description: name,
					inputSchema: z.object({}),
					category: 'custom',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async () => {
						executions.push(name)
						return { success: true, output: `${name} ran again` }
					},
				}),
			)
		}

		const resumed = await resumeSession({
			scope: {
				tenantId: crashed.scope.tenantId,
				projectId: crashed.scope.projectId,
				sessionId: crashed.sessionId,
				turnId: crashed.turnId,
				topicId: memorySession().topicId,
			},
			sessionLog: crashed.log,
			checkpointStore: crashed.store,
			sessionId: crashed.sessionId,
			topicId: memorySession().topicId,
			projectId: crashed.scope.projectId,
			tenantId: crashed.scope.tenantId,
			checkpointId: crashed.checkpointId,
			provider: new MockLLMProvider({ turns: [{ text: 'understood' }] }),
			tools,
			agentId: 'agent_partial_batch',
			agentName: 'Partial batch agent',
			workingDirectory,
			authorizationGate: {
				...gate,
				rules: [{ type: 'allow_by_name', toolNames: ['first', 'second'] }],
			},
			turnConfig: RUN_CONFIG,
		} as unknown as ResumeSessionParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return

		// The call that came back is answered by the checkpoint and does not
		// run again.
		expect(executions).not.toContain('first')

		// Both `tool_use` blocks are answered, which is the structural
		// requirement: the provider rejects a request carrying an unanswered
		// block, and the turn would not be resumable at all without this.
		const toolResults = resumed.turn.messages.filter((message) => message.role === 'tool')
		const answered = toolResults.map((message) => (message as { toolCallId: string }).toolCallId)
		expect(answered).toContain('call_one')
		expect(answered).toContain('call_two')
	})
})
