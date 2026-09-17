import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLDecisionRequest, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { findPendingCheckpoint } from '../checkpoint.js'
import { type QueryParams, drainQuery } from '../index.js'
import { type ResumeRunParams, resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

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

const SCOPE: RunStateScope = {
	runId: fixtureId.run('refused-resume-plan'),
	tenantId: generateTenantId(),
	projectId: generateProjectId(),
	sessionId: generateSessionId(),
	topicId: generateTopicId(),
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
	async function parkOnReview(store: InMemoryCheckpointStore, executions: string[]) {
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
				checkpointStore: store,
				agentId: 'agent_refused_plan',
				agentName: 'Refused plan agent',
				messages: [{ role: 'user', content: 'deploy it' }],
				workingDirectory,
				runId: SCOPE.runId,
				tenantId: SCOPE.tenantId,
				projectId: SCOPE.projectId,
				sessionId: SCOPE.sessionId,
				topicId: SCOPE.topicId,
				authorizationGate: gate,
				resumeHandler: async (request: HITLDecisionRequest) =>
					request.type === 'tool_review'
						? { action: 'pause', reason: 'let me look at that' }
						: { action: 'continue' },
				runConfig: RUN_CONFIG,
			} as unknown as QueryParams,
			(_event: RunEvent) => {},
		)
		return workingDirectory
	}

	/**
	 * A run store that can PROVE a call has no recorded start.
	 *
	 * `recoverCompletedCalls` treats `complete: true` with no record as
	 * evidence, and only then may the call be left alone. Without it the
	 * reading is "unknown evidence", which is a different branch.
	 */
	function storeProvingNothingStarted(): InMemoryRunStore {
		return Object.assign(new InMemoryRunStore(), {
			readToolExecutions: async () => ({ complete: true, records: new Map() }),
		})
	}

	it('still finds the park afterwards, because nothing was carried out', async () => {
		const store = new InMemoryCheckpointStore()
		const executions: string[] = []
		const workingDirectory = await parkOnReview(store, executions)

		expect(executions).toEqual([])
		const reviewPark = (await findPendingCheckpoint(store, SCOPE)) as IterationCheckpoint
		expect(reviewPark?.pending?.request.type).toBe('tool_review')

		// `continue` does not describe what to do with a batch of pending tool
		// calls — `planPendingResume` says so and returns null rather than
		// guessing at an approval.
		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			runStore: storeProvingNothingStarted(),
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: new MockLLMProvider({ turns: [{ text: 'never mind, I will ask again' }] }),
			tools: deployRegistry(executions),
			agentId: 'agent_refused_plan',
			agentName: 'Refused plan agent',
			workingDirectory,
			authorizationGate: gate,
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)

		// Nothing was executed — the decision did not authorize anything.
		expect(executions).toEqual([])

		// And the park is STILL outstanding. The decision was never carried
		// out, so the request is still owed an answer; an approval queue that
		// had this cleared for it would show the run as having nothing left to
		// do, when in fact it is waiting on the same question it was before.
		const stillPending = await findPendingCheckpoint(store, SCOPE)
		expect(stillPending?.id).toBe(reviewPark.id)
		expect(stillPending?.pending?.resolvedAt).toBeUndefined()
	})

	it('records that the park was superseded when CRASH RECOVERY did the work', async () => {
		// FLIPPED 2026-09-18, by the commit that fixed what this used to pin.
		// When `recoverCompletedCalls` cannot prove anything, the crash path
		// produces a plan of its own, and the unpark at `index.ts` used to
		// record `params.pendingDecision` against that plan's checkpoint — the
		// human's "continue" written down as the park's answer while the batch
		// was answered with an UNKNOWN OUTCOME. That assertion
		// (`decision).toMatchObject({ action: 'continue' })`) is what moved.
		//
		// The park is still resolved, because the question it asks is moot and
		// leaving it outstanding is worse than either record: it is the newest
		// outstanding park, so `findPendingCheckpoint` serves it, and resuming
		// it would rewind this run to the checkpoint the crash happened on and
		// re-execute a batch the run has long since moved past. What changed is
		// what the record SAYS — it no longer claims the run carried out a
		// decision it never applied.
		const store = new InMemoryCheckpointStore()
		const executions: string[] = []
		const workingDirectory = await parkOnReview(store, executions)
		const reviewPark = (await findPendingCheckpoint(store, SCOPE)) as IterationCheckpoint
		expect(reviewPark?.pending?.request.type).toBe('tool_review')

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			runStore: new InMemoryRunStore(),
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'continue' },
			provider: new MockLLMProvider({ turns: [{ text: 'never mind' }] }),
			tools: deployRegistry(executions),
			agentId: 'agent_refused_plan',
			agentName: 'Refused plan agent',
			workingDirectory,
			authorizationGate: gate,
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		expect(executions).toEqual([])
		// The park stops being served: recovery answered the batch, so nothing
		// is waiting on the answer to this question any more.
		expect(await findPendingCheckpoint(store, SCOPE)).toBeNull()
		const recorded = (await store.listCheckpoints(SCOPE)).find(
			(checkpoint) => checkpoint.id === reviewPark.id,
		)
		expect(recorded?.pending?.resolvedAt).toBeGreaterThan(0)
		// ...but the answer on it is NOT the human's `continue`, which is what
		// this case used to assert. Recovery spoke instead of the decision, so
		// the record says the park was superseded rather than answered —
		// `pause` is the vocabulary `expire` already uses for "this park ended
		// and no decision was carried out", chosen there over `abort` because
		// an abort would read as somebody having refused it.
		const decision = recorded?.pending?.decision as { action?: string; reason?: string } | undefined
		expect(decision?.action).toBe('pause')
		expect(String(decision?.reason)).toMatch(/recovery/i)
		// What was asked stays on the record, so the evidence of the question
		// survives the answer that superseded it.
		expect(recorded?.pending?.request.type).toBe('tool_review')
	})

	it('still records the decision itself when the decision IS applied', async () => {
		// The control for the case above, and the guard on the fix that changed
		// it: a decision that DID reach the calls it named must still be
		// recorded as itself. A discriminator that labelled the applied case as
		// superseded would satisfy the case above and fail this one, and the
		// record would then no longer say who approved what — the one thing an
		// approval gate's evidence exists for. This case passes before and
		// after that fix; it is here to keep the fix from over-reaching.
		const store = new InMemoryCheckpointStore()
		const executions: string[] = []
		const workingDirectory = await parkOnReview(store, executions)
		const reviewPark = (await findPendingCheckpoint(store, SCOPE)) as IterationCheckpoint

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			// Complete evidence that nothing started, so `planPendingResume`
			// gets to apply the decision rather than the crash path taking over.
			runStore: storeProvingNothingStarted(),
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			pendingDecision: { action: 'approve_tools' },
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: deployRegistry(executions),
			agentId: 'agent_refused_plan',
			agentName: 'Refused plan agent',
			workingDirectory,
			authorizationGate: gate,
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		// The approval was CARRIED OUT: the call the human approved ran.
		expect(executions).toEqual(['deploy'])

		expect(await findPendingCheckpoint(store, SCOPE)).toBeNull()
		const recorded = (await store.listCheckpoints(SCOPE)).find(
			(checkpoint) => checkpoint.id === reviewPark.id,
		)
		expect(recorded?.pending?.resolvedAt).toBeGreaterThan(0)
		expect(recorded?.pending?.decision).toEqual({ action: 'approve_tools' })
	})
})

describe('a partially-applied tool batch', () => {
	it('is not resumed as though its unanswered calls had completed', async () => {
		const workingDirectory = await workdir()
		const store = new InMemoryCheckpointStore()
		const executions: string[] = []

		// The shape a crash leaves: the assistant asked for two calls, one
		// came back, and the run died. Nothing in the transcript says the
		// second call happened.
		const checkpoint = {
			id: fixtureId.checkpoint('partial-batch'),
			runId: SCOPE.runId,
			runCreatedAt: Date.now() - 60_000,
			iteration: 1,
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
			tokenUsage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			costInfo: {
				inputCostPer1M: 0,
				outputCostPer1M: 0,
				totalCost: 0,
				cacheDiscount: 0,
				unpricedTokens: 0,
			},
			guardState: { iterationCount: 1, elapsedMs: 1_000 },
			createdAt: Date.now() - 59_000,
		} as unknown as IterationCheckpoint
		await store.writeCheckpoint(SCOPE, checkpoint)

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

		const resumed = await resumeRun({
			scope: SCOPE,
			checkpointStore: store,
			runStore: new InMemoryRunStore(),
			sessionId: SCOPE.sessionId,
			topicId: SCOPE.topicId,
			projectId: SCOPE.projectId,
			tenantId: SCOPE.tenantId,
			checkpointId: checkpoint.id,
			provider: new MockLLMProvider({ turns: [{ text: 'understood' }] }),
			tools,
			agentId: 'agent_partial_batch',
			agentName: 'Partial batch agent',
			workingDirectory,
			authorizationGate: {
				...gate,
				rules: [{ type: 'allow_by_name', toolNames: ['first', 'second'] }],
			},
			runConfig: RUN_CONFIG,
		} as unknown as ResumeRunParams)

		expect(resumed.resumed).toBe(true)
		if (!resumed.resumed) return

		// Neither call ran again: the one that came back is answered by the
		// checkpoint, and the one that did not is an UNKNOWN outcome — a call
		// whose start cannot be proved must never be replayed, because for a
		// payment or an email "run it again" is the one thing you cannot take
		// back.
		expect(executions).toEqual([])

		// Both `tool_use` blocks are answered, which is the structural
		// requirement: the provider rejects a request carrying an unanswered
		// block, and the run would not be resumable at all without this.
		const toolResults = resumed.run.messages.filter((message) => message.role === 'tool')
		const answered = toolResults.map((message) => (message as { toolCallId: string }).toolCallId)
		expect(answered).toContain('call_one')
		expect(answered).toContain('call_two')

		// And the incompleteness is ON the record rather than papered over:
		// the second call's result says its outcome is unknown.
		const second = resumed.run.messages.find(
			(message) =>
				message.role === 'tool' && (message as { toolCallId: string }).toolCallId === 'call_two',
		)
		expect(String((second as { content: unknown }).content)).toMatch(/unknown|interrupted/i)
	})
})
