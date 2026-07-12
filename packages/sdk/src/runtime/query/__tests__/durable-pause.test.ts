// Current-code invariants asserted (2026-07-13, ses_017 D1/D2):
//
// A paused run used to LOSE THE DECISION IT WAS PAUSED FOR.
//
// A review is an in-process `await ctx.resumeHandler(request)` and nothing about the
// request was persisted. Resuming is a fresh `query()`, and `prepareResumeMessages`
// runs `repairDanglingMessages`, which sees the still-unexecuted assistant tool call
// as an interrupted pair and rewrites it into a "[SYSTEM] Tool result missing"
// placeholder. The call the human was asked to approve was silently destroyed, and
// the model was told the tool had failed. The repair is RIGHT for a crash and WRONG
// for a pause, and the record could not tell them apart precisely BECAUSE the pending
// decision was not persisted.
//
//   - A review that parks the run persists a `pendingDecision` on the review
//     checkpoint: `{ requestId, request, state: 'pending', resumeToken }`. It survives
//     a real RunDiskStore → JSON → restore round trip.
//   - `repairDanglingMessages` does NOT touch a tool-call block that a live pending
//     decision owns. The block is not repaired, not compacted, and is never handed to
//     a provider before the resume dispatcher has acted on it — three separate
//     assertions, and they are the core invariant.
//   - The resume dispatcher sits in `query()`, OUTSIDE `runLoop`: restore without
//     repair → hydrate → build deps → dispatch → enter the loop.
//   - `state: 'resolved'` executes exactly the approved calls, each re-gated at
//     dispatch, writes denial results for the rest, then completes the interrupted
//     iteration's TAIL (post-tool checkpoint, advisory, `iteration_end`,
//     `iteration_completed`) rather than starting a fresh iteration.
//   - `state: 'pending'` re-emits the SAME requestId and parks again. Idempotent.
//   - A resume token is single-use: redeeming it twice is refused.
//   - `state: 'executing'` after a crash NEVER silently re-runs. The per-call journal
//     says which calls settled (their results are kept) and which started but never
//     settled (surfaced as "may have already run", never re-executed).
//   - A cancelled run's pending decision cannot be resumed.
//   - The in-process ResumeHandler fast path is unchanged.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type { ProjectId, RunId, SessionId, TenantId, ThreadId } from '../../../types/ids/index.js'
import type { Message } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { projectEmergencyToCheckpoint } from '../checkpoint.js'
import {
	DecisionAlreadyResolvedError,
	DecisionOutcomeInvalidError,
	DecisionTokenInvalidError,
	EmergencyProjectionUnresumableError,
	RunNotResumableError,
} from '../decision/errors.js'
import { cancelDecision, readPendingDecision, resumeDecision } from '../decision/resume.js'
import { drainQuery, query } from '../index.js'
import { prepareReplayState } from '../replay/prepare.js'

const RUN_ID = 'run_durable_pause' as RunId
const SESSION_ID = 'ses_test' as SessionId
const THREAD_ID = 'thd_test' as ThreadId
const PROJECT_ID = 'prj_test' as ProjectId
const TENANT_ID = 'tnt_test' as TenantId

const USAGE = {
	promptTokens: 10,
	completionTokens: 10,
	totalTokens: 20,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

/** The placeholder `repairDanglingMessages` writes over an unanswered tool call. */
const REPAIR_PLACEHOLDER = '[SYSTEM] Tool result missing'

interface RecordingProvider extends LLMProvider {
	/** Message history handed to the provider, per call, in order. */
	readonly seen: Message[][]
}

/**
 * Asks for one tool call on its first turn, then ends. Records every history it is
 * handed — which is how we prove what the provider was, and was not, shown.
 */
function recordingProvider(): RecordingProvider {
	const seen: Message[][] = []
	let turn = 0
	return {
		id: 'fake',
		name: 'Fake',
		seen,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			seen.push(params.messages.map((m) => ({ ...m })))
			turn++
			if (turn === 1) {
				return {
					id: 'r',
					model: 'm',
					message: {
						role: 'assistant',
						content: 'I will write the file now',
						toolCalls: [
							{ id: 'call_1', type: 'function', function: { name: 'noop', arguments: '{}' } },
						],
					},
					finishReason: 'tool_calls',
					usage: USAGE,
				} as ChatCompletionResponse
			}
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'all done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

/** A provider that ONLY ends the turn — used on the resume leg. */
function stoppingRecordingProvider(): RecordingProvider {
	const seen: Message[][] = []
	return {
		id: 'fake',
		name: 'Fake',
		seen,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			seen.push(params.messages.map((m) => ({ ...m })))
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'all done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

function noopTool(calls: string[]): ToolDefinition<Record<string, never>> {
	return {
		name: 'noop',
		description: 'does nothing',
		inputSchema: z.object({}).strict() as unknown as z.ZodType<
			Record<string, never>,
			z.ZodTypeDef,
			unknown
		>,
		async execute() {
			calls.push('noop')
			return { success: true, output: 'ok' }
		},
	}
}

function registryWith(tool: ToolDefinition<Record<string, never>>): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(tool as unknown as ToolDefinition)
	return tools
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-d1-'))
}

interface Driven {
	run: Run
	events: RunEvent[]
}

async function drive(opts: {
	cwd: string
	provider: LLMProvider
	tools: ToolRegistry
	decision: HITLResumeDecision
	resumeFromCheckpoint?: `cp_${string}`
}): Promise<Driven> {
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: opts.tools,
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: opts.resumeFromCheckpoint,
			resumeHandler: async (_req: HITLDecisionRequest) => opts.decision,
		},
		(e) => {
			events.push(e)
		},
	)
	return { run, events }
}

function pausedCheckpointId(events: RunEvent[]): `cp_${string}` {
	const paused = events.find((e) => e.type === 'run_paused')
	if (!paused) throw new Error('run never paused')
	return (paused as { checkpointId: `cp_${string}` }).checkpointId
}

/** Where the run's files live — what `resumeDecision` addresses the durable record by. */
function runsDir(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

/** Park a run at a tool review, and hand back everything needed to answer it. */
async function pauseAtReview(cwd: string, calls: string[]) {
	const first = await drive({
		cwd,
		provider: recordingProvider(),
		tools: registryWith(noopTool(calls)),
		decision: { action: 'pause', reason: 'stepping away' },
	})
	const checkpointId = pausedCheckpointId(first.events)
	const baseDir = runsDir(cwd)
	const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
	if (!decision) throw new Error('no pending decision was persisted')
	return { first, checkpointId, baseDir, decision }
}

/**
 * A tool with a real-world side effect, standing in for everything that makes
 * "just re-run it" unacceptable.
 */
function chargeTool(calls: string[]): ToolDefinition<Record<string, never>> {
	return {
		name: 'charge',
		description: 'charges a card',
		inputSchema: z.object({}).passthrough() as never,
		async execute(input: { n?: number }) {
			calls.push(`charge:${input.n ?? '?'}`)
			return { success: true, output: `charged ${input.n ?? '?'}` }
		},
	}
}

/** Asks for TWO calls, so a batch can be crashed halfway through. */
function twoCallProvider(): RecordingProvider {
	const seen: Message[][] = []
	let turn = 0
	return {
		id: 'fake',
		name: 'Fake',
		seen,
		async chat(params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			seen.push(params.messages.map((m) => ({ ...m })))
			turn++
			if (turn === 1) {
				return {
					id: 'r',
					model: 'm',
					message: {
						role: 'assistant',
						content: 'charging both',
						toolCalls: [
							{
								id: 'call_1',
								type: 'function',
								function: { name: 'charge', arguments: '{"n":1}' },
							},
							{
								id: 'call_2',
								type: 'function',
								function: { name: 'charge', arguments: '{"n":2}' },
							},
						],
					},
					finishReason: 'tool_calls',
					usage: USAGE,
				} as ChatCompletionResponse
			}
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'all done' },
				finishReason: 'stop',
				usage: USAGE,
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

async function pauseAtTwoCallReview(cwd: string, calls: string[]) {
	const events: RunEvent[] = []
	await drainQuery(
		{
			provider: twoCallProvider(),
			tools: registryWith(chargeTool(calls)),
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeHandler: async () => ({ action: 'pause', reason: 'need approval' }),
		},
		(e) => {
			events.push(e)
		},
	)
	const checkpointId = pausedCheckpointId(events)
	const baseDir = runsDir(cwd)
	const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
	if (!decision) throw new Error('no pending decision was persisted')
	return { checkpointId, baseDir, decision }
}

async function driveTwoCall(opts: {
	cwd: string
	provider: LLMProvider
	calls: string[]
	resumeFromCheckpoint: `cp_${string}`
	onEvent?: (e: RunEvent) => void
}): Promise<{ run: Run }> {
	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: registryWith(chargeTool(opts.calls)),
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: opts.resumeFromCheckpoint,
			resumeHandler: async () => ({ action: 'continue' }),
		},
		opts.onEvent,
	)
	return { run }
}

describe('THE BUG: a paused run loses the decision it was paused for', () => {
	it('does not destroy the pending tool call on resume', async () => {
		const cwd = tmp()
		const calls: string[] = []

		// Leg 1: the run reaches a tool review and the human parks it.
		const { first, checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)
		expect(first.run.status).toBe('awaiting_input')
		expect(calls).toEqual([]) // the tool has NOT run — it is awaiting approval

		// The human answers, out of band, hours later. Redeeming the token records the
		// outcome on the checkpoint; it does not run anything.
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})
		expect(calls).toEqual([]) // still nothing has run — redemption is not execution

		// Leg 2: a fresh process resumes from the checkpoint the pause named.
		const resumeProvider = stoppingRecordingProvider()
		await drive({
			cwd,
			provider: resumeProvider,
			tools: registryWith(noopTool(calls)),
			decision: { action: 'continue' },
			resumeFromCheckpoint: checkpointId,
		})

		// The history the provider was handed on the resumed run's FIRST model call.
		// Before D1/D2, `prepareResumeMessages` had already rewritten the pending tool
		// call into a "tool result missing" placeholder — the model was told the tool
		// failed, and the decision the human was asked for was gone.
		const handed = resumeProvider.seen[0] ?? []
		const toolResults = handed.filter((m) => m.role === 'tool').map((m) => String(m.content))

		expect(toolResults.some((c) => c.includes(REPAIR_PLACEHOLDER))).toBe(false)
		expect(toolResults.some((c) => c.includes('ok'))).toBe(true)
		expect(calls).toEqual(['noop']) // the approved call ran, exactly once
	})
})

describe('D1: the pending decision is persisted, and survives a real round trip', () => {
	it('survives checkpoint → RunDiskStore → JSON → restore', async () => {
		const cwd = tmp()
		const { checkpointId, decision } = await pauseAtReview(cwd, [])

		// Read it back through a brand-new store — the same path a fresh process takes.
		// Nothing is shared with the writer but the bytes on disk.
		const store = new RunDiskStore({ baseDir: runsDir(cwd) })
		await store.initRun(RUN_ID)
		const restored = await store.readCheckpoint(checkpointId)
		const pd = restored?.pendingDecision

		expect(pd).toBeDefined()
		expect(pd?.requestId).toBe(decision.requestId)
		expect(pd?.state).toBe('pending')
		expect(pd?.resumeToken).toBe(decision.resumeToken)
		expect(pd?.request.type).toBe('tool_review')
		expect(pd?.request).toMatchObject({ runId: RUN_ID, checkpointId })

		// The question itself round-trips, not just its id — a resume has to be able to
		// re-ASK it, and an id alone cannot be re-emitted to a human.
		const req = pd?.request as { toolCalls: Array<{ id: string; name: string }> }
		expect(req.toolCalls).toEqual([
			expect.objectContaining({ id: 'call_1', name: 'noop', isDestructive: false }),
		])

		// And the tool-call block it is about is still there, unanswered.
		expect(restored?.messages.some((m) => m.role === 'tool')).toBe(false)
		const assistant = restored?.messages.at(-1) as { role: string; toolCalls?: unknown[] }
		expect(assistant.role).toBe('assistant')
		expect(assistant.toolCalls).toHaveLength(1)
	})

	it('marks the run awaiting_input on disk, with the decision reachable from the pause event', async () => {
		const cwd = tmp()
		const { first, checkpointId } = await pauseAtReview(cwd, [])

		expect(first.run.status).toBe('awaiting_input')

		// `run_paused` names the checkpoint, and the checkpoint has the decision. That
		// chain is the whole of "a pause you can come back to".
		const decision = await readPendingDecision({
			baseDir: runsDir(cwd),
			runId: RUN_ID,
			checkpointId,
		})
		expect(decision?.state).toBe('pending')
	})
})

describe('D2: the core invariant — nothing sees the pending block before the dispatcher', () => {
	it('does NOT repair the pending tool-call block on the way in', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const provider = stoppingRecordingProvider()
		const { run } = await drive({
			cwd,
			provider,
			tools: registryWith(noopTool(calls)),
			decision: { action: 'continue' },
			resumeFromCheckpoint: checkpointId,
		})

		// The repair's fingerprint appears NOWHERE — not in the history the provider saw,
		// not in the run's final messages. `repairDanglingMessages` never touched the block.
		const everything = [...(provider.seen[0] ?? []), ...run.messages]
		expect(everything.some((m) => String(m.content ?? '').includes(REPAIR_PLACEHOLDER))).toBe(false)
	})

	it('does NOT compact the pending block before dispatch, and does NOT send it to a provider un-dispatched', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// Compaction that triggers on EVERY iteration (threshold 0). If it ran before the
		// dispatcher it would run against the pending block — the exact hazard.
		const order: string[] = []
		const provider = stoppingRecordingProvider()
		const orderedTool: ToolDefinition<Record<string, never>> = {
			...noopTool(calls),
			async execute() {
				order.push('tool')
				calls.push('noop')
				return { success: true, output: 'ok' }
			},
		}
		const events: RunEvent[] = []
		await drainQuery(
			{
				provider: {
					...provider,
					async chat(params: ChatCompletionParams) {
						order.push('provider')
						return provider.chat(params)
					},
				} as LLMProvider,
				tools: registryWith(orderedTool),
				runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
				agentId: 'agent_test',
				agentName: 'Test',
				workingDirectory: cwd,
				messages: [],
				runId: RUN_ID,
				sessionId: SESSION_ID,
				threadId: THREAD_ID,
				projectId: PROJECT_ID,
				tenantId: TENANT_ID,
				resumeFromCheckpoint: checkpointId,
				// `triggerThreshold: 0` — compaction wants to run on EVERY iteration. If it
				// ran before the dispatcher it would run against the pending tool-call block,
				// which is the hazard this test exists to rule out.
				compactionConfig: {
					strategy: 'structured',
					triggerThreshold: 0,
					resetThreshold: 0.4,
					keepRecentMessages: 1,
					maxToolResults: 30,
					maxListSize: 25,
					llmVerification: false,
					llmVerificationMaxTokens: 2048,
					richStateThreshold: 15,
					convoTextBudget: 12_000,
					maxSentencesPerTurn: 5,
					maxCharsPerNote: 500,
					maxCharsPerRequirement: 300,
					maxCharsPerTask: 400,
				},
				resumeHandler: async () => ({ action: 'continue' }),
			},
			(e) => {
				events.push(e)
			},
		)

		// (a) THE TOOL RAN BEFORE ANY MODEL CALL. The dispatcher is upstream of the loop,
		//     so the provider cannot possibly have been handed the un-dispatched block.
		expect(order[0]).toBe('tool')
		expect(order.indexOf('tool')).toBeLessThan(order.indexOf('provider'))

		// (b) The provider's first history carries the REAL result, never the repair
		//     placeholder and never a bare unanswered tool-call block.
		const handed = provider.seen[0] ?? []
		const toolMsgs = handed.filter((m) => m.role === 'tool').map((m) => String(m.content))
		expect(toolMsgs).toContain('ok')
		expect(toolMsgs.some((c) => c.includes(REPAIR_PLACEHOLDER))).toBe(false)

		// (c) Every tool call in the history the provider saw HAS a result. An assistant
		//     tool-call block with no results is precisely what the repair exists to
		//     prevent, and suppressing the repair is only safe because the dispatcher
		//     runs first.
		const assistantCallIds = handed
			.filter((m) => m.role === 'assistant')
			.flatMap((m) =>
				((m as { toolCalls?: Array<{ id: string }> }).toolCalls ?? []).map((c) => c.id),
			)
		const answeredIds = handed
			.filter((m) => m.role === 'tool')
			.map((m) => (m as { toolCallId: string }).toolCallId)
		for (const id of assistantCallIds) {
			expect(answeredIds).toContain(id)
		}
	})
})

describe('D2: resume applies the outcome and finishes the iteration it interrupted', () => {
	it("resolved → executes exactly the approved calls, re-gated, and completes the interrupted iteration's TAIL", async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const events: RunEvent[] = []
		const hooks: string[] = []
		const pluginManager = {
			async executeHooks(event: string) {
				hooks.push(event)
				return []
			},
		} as unknown as NonNullable<Parameters<typeof drainQuery>[0]['pluginManager']>

		await drainQuery(
			{
				provider: stoppingRecordingProvider(),
				tools: registryWith(noopTool(calls)),
				runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
				agentId: 'agent_test',
				agentName: 'Test',
				workingDirectory: cwd,
				messages: [],
				runId: RUN_ID,
				sessionId: SESSION_ID,
				threadId: THREAD_ID,
				projectId: PROJECT_ID,
				tenantId: TENANT_ID,
				resumeFromCheckpoint: checkpointId,
				pluginManager,
				resumeHandler: async () => ({ action: 'continue' }),
			},
			(e) => {
				events.push(e)
			},
		)

		expect(calls).toEqual(['noop']) // exactly the approved call, exactly once

		// The interrupted iteration was iteration 1. Its TAIL runs — not a fresh
		// iteration. Starting iteration 2 instead would silently skip the post-tool
		// checkpoint, the advisory phase and the `iteration_end` hooks that belong to the
		// iteration whose tools actually ran.
		const completed = events.filter((e) => e.type === 'iteration_completed')
		expect(completed.map((e) => (e as { iteration: number }).iteration)).toContain(1)

		// ...and it did NOT re-announce iteration 1's start. That already happened, in
		// the segment before the pause.
		const started = events
			.filter((e) => e.type === 'iteration_started')
			.map((e) => (e as { iteration: number }).iteration)
		expect(started).not.toContain(1)

		// The post-tool checkpoint (the tail's own) was written.
		expect(events.some((e) => e.type === 'checkpoint_created')).toBe(true)

		// The tail's iteration_end hook fired.
		expect(hooks).toContain('iteration_end')
	})

	it('re-gates an approved call at dispatch — a decision is not a bypass of the deny plane', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// The gate now denies `noop`. The human approved it hours ago; policy has moved
		// on. The call is authorized at DISPATCH, against the input that actually runs —
		// so the stale approval does not carry it through (authorize-what-runs).
		await drainQuery({
			provider: stoppingRecordingProvider(),
			tools: registryWith(noopTool(calls)),
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: checkpointId,
			verificationGate: {
				enabled: true,
				rules: [{ type: 'deny_by_name', toolNames: ['noop'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			resumeHandler: async () => ({ action: 'continue' }),
		})

		expect(calls).toEqual([]) // the tool did NOT run, despite a recorded approval
	})
})

describe('D2: a decision that is still unanswered is re-emitted, not lost', () => {
	it('pending → re-emits the SAME requestId and parks again (idempotent)', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, decision } = await pauseAtReview(cwd, calls)

		// Resume WITHOUT redeeming the token. Nobody has answered yet.
		const events: RunEvent[] = []
		const provider = stoppingRecordingProvider()
		const run = await drainQuery(
			{
				provider,
				tools: registryWith(noopTool(calls)),
				runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
				agentId: 'agent_test',
				agentName: 'Test',
				workingDirectory: cwd,
				messages: [],
				runId: RUN_ID,
				sessionId: SESSION_ID,
				threadId: THREAD_ID,
				projectId: PROJECT_ID,
				tenantId: TENANT_ID,
				resumeFromCheckpoint: checkpointId,
				// Deliberately an auto-approving handler: the decision must come through the
				// token, not through whatever handler happens to be in the resuming process.
				resumeHandler: async () => ({ action: 'approve_tools' }),
			},
			(e) => {
				events.push(e)
			},
		)

		// Parked again, nothing executed, no model call made.
		expect(run.status).toBe('awaiting_input')
		expect(calls).toEqual([])
		expect(provider.seen).toHaveLength(0)

		// The SAME question, under the SAME id. A client that already asked its human is
		// not made to ask again under a new name.
		const reEmitted = events.find((e) => e.type === 'tool_review_requested')
		expect(reEmitted).toBeDefined()
		expect((reEmitted as { requestId: string }).requestId).toBe(decision.requestId)

		// And the persisted decision is untouched — same id, same token, still pending.
		const after = await readPendingDecision({ baseDir: runsDir(cwd), runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('pending')
		expect(after?.resumeToken).toBe(decision.resumeToken)
		expect(after?.requestId).toBe(decision.requestId)
	})
})

describe('D1: the resume token is a single-use capability', () => {
	it('refuses a second redemption', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, [])

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// The same token, again. Redeeming invalidated it.
		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'reject_tools', feedback: 'changed my mind' },
			}),
		).rejects.toThrow(DecisionAlreadyResolvedError)

		// The FIRST outcome stands. A second answer does not overwrite the one the run
		// is already acting on — and the recorded outcome rides on the error so a route
		// can tell an exact duplicate from a conflicting one.
		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.outcome).toEqual({ action: 'approve_tools' })
	})

	it('refuses a token that is not this decision’s', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir } = await pauseAtReview(cwd, [])

		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: `rt_${'0'.repeat(64)}`,
				decision: { action: 'approve_tools' },
			}),
		).rejects.toThrow(DecisionTokenInvalidError)

		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('pending') // a failed guess spends nothing
	})

	it('refuses an outcome that does not answer the question asked', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, [])

		// `pause` cannot answer an already-paused review: the token would be spent and the
		// run left parked on a decision nothing could ever answer again.
		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'pause', reason: 'still thinking' },
			}),
		).rejects.toThrow(DecisionOutcomeInvalidError)

		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('pending') // still answerable
	})
})

describe('P4 through this path: a cancelled run cannot be resumed', () => {
	it('refuses redemption once the decision is cancelled', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, [])

		await cancelDecision({ baseDir, runId: RUN_ID, checkpointId })

		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).rejects.toThrow(DecisionAlreadyResolvedError)
	})

	it('refuses redemption when the RUN is terminal, even with a valid token and a pending decision', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, [])

		// The run is cancelled but nobody remembered to close its open decisions — which
		// is exactly the case the structural check exists for. The decision still reads
		// `pending` and the token is still valid, and it STILL cannot be resumed.
		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		const meta = await store.readRunMeta()
		if (!meta) throw new Error('no run meta')
		await store.writeRunMeta({
			...meta,
			status: 'cancelled',
			messages: [],
			costInfo: { inputCost: 0, outputCost: 0, totalCost: 0 },
		} as never)

		const stillPending = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(stillPending?.state).toBe('pending')

		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).rejects.toThrow(RunNotResumableError)
	})
})

describe('D2: a crash in `executing` never silently re-runs a tool', () => {
	/**
	 * Stage a checkpoint that looks exactly like a process that died mid-`executeBatch`:
	 * the decision is `executing`, and the journal says one call settled (we have its
	 * result) while the other started and never came back (its effect is unknown).
	 */
	async function stageCrashedBatch(cwd: string, calls: string[]) {
		const { checkpointId, baseDir, decision } = await pauseAtTwoCallReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		await store.updateCheckpoint(checkpointId, (cp) => {
			const pd = cp.pendingDecision
			if (!pd) throw new Error('no decision to crash')
			return {
				...cp,
				pendingDecision: {
					...pd,
					state: 'executing' as const,
					journal: [
						{
							toolCallId: 'call_1',
							toolName: 'charge',
							state: 'settled' as const,
							at: Date.now(),
							output: 'charged $100 (receipt r_123)',
						},
						// call_2 was dispatched and never came back. It MAY have charged the card.
						{
							toolCallId: 'call_2',
							toolName: 'charge',
							state: 'started' as const,
							at: Date.now(),
						},
					],
				},
			}
		})

		return { checkpointId, baseDir }
	}

	it('keeps a settled call’s result and does NOT re-run it', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId } = await stageCrashedBatch(cwd, calls)

		const provider = stoppingRecordingProvider()
		const { run } = await driveTwoCall({ cwd, provider, calls, resumeFromCheckpoint: checkpointId })

		// NEITHER call ran again. Not the one we have a result for, and not the one whose
		// fate we do not know. Re-running a settled charge double-charges; re-running an
		// unsettled one might too, and there is no way to find out from here.
		expect(calls).toEqual([])

		// The settled call keeps the result the journal recorded.
		const results = run.messages.filter((m) => m.role === 'tool')
		const settled = results.find((m) => (m as { toolCallId: string }).toolCallId === 'call_1')
		expect(settled?.content).toBe('charged $100 (receipt r_123)')
	})

	it('surfaces the started-but-unsettled call as "may have already run"', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await stageCrashedBatch(cwd, calls)

		const events: RunEvent[] = []
		const provider = stoppingRecordingProvider()
		const { run } = await driveTwoCall({
			cwd,
			provider,
			calls,
			resumeFromCheckpoint: checkpointId,
			onEvent: (e) => {
				events.push(e)
			},
		})

		// The MODEL is told, in the tool result, that the call may have run and was not
		// retried. Telling it the tool "failed" would invite it to try again.
		const uncertain = run.messages.find(
			(m) => m.role === 'tool' && (m as { toolCallId: string }).toolCallId === 'call_2',
		)
		expect(String(uncertain?.content)).toContain('MAY have already run')
		expect(String(uncertain?.content)).toContain('NOT re-executed')

		// The HUMAN is told, on the event stream.
		const surfaced = events.filter((e) => e.type === 'tool_execution_uncertain')
		expect(surfaced).toHaveLength(1)
		expect(surfaced[0]).toMatchObject({ toolCallId: 'call_2', toolName: 'charge' })

		// And it is recorded on the decision, so an operator can find it after the fact.
		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('settled')
		expect(after?.uncertainToolCallIds).toEqual(['call_2'])
	})

	it('the journal is written per call as it settles, not once when the batch does', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtTwoCallReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// call_1 returns at once. call_2 stays in flight and polls the journal on disk
		// until it sees call_1 recorded as settled. That is only possible if the journal
		// is written PER CALL as it comes back — if it were written once, after
		// `Promise.all`, nothing could be on disk while call_2 is still running, and a
		// crash right here would be unattributable. Which is exactly the gap.
		let journalMidFlight: unknown

		const pollingChargeTool: ToolDefinition<Record<string, never>> = {
			name: 'charge',
			description: 'charges a card',
			inputSchema: z.object({}).passthrough() as never,
			async execute(input: { n?: number }) {
				if (input.n !== 2) {
					return { success: true, output: 'charged 1' }
				}
				const deadline = Date.now() + 2000
				while (Date.now() < deadline) {
					const pd = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
					const one = pd?.journal?.find((e) => e.toolCallId === 'call_1')
					if (one?.state === 'settled') {
						journalMidFlight = pd?.journal
						break
					}
					await new Promise((r) => setTimeout(r, 10))
				}
				return { success: true, output: 'charged 2' }
			},
		}

		await drainQuery({
			provider: stoppingRecordingProvider(),
			tools: registryWith(pollingChargeTool),
			runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: checkpointId,
			resumeHandler: async () => ({ action: 'continue' }),
		})

		// Mid-flight, the journal already knew call_1 was done — with its output.
		const mid = (journalMidFlight ?? []) as Array<{
			toolCallId: string
			state: string
			output?: string
		}>
		const one = mid.find((e) => e.toolCallId === 'call_1')
		expect(one?.state).toBe('settled')
		expect(one?.output).toBe('charged 1')
	})
})

describe('the in-process ResumeHandler fast path is unchanged (regression)', () => {
	it('a synchronous approve executes the batch and finishes the run, with no decision persisted', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				provider: recordingProvider(),
				tools: registryWith(noopTool(calls)),
				runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
				agentId: 'agent_test',
				agentName: 'Test',
				workingDirectory: cwd,
				messages: [],
				runId: RUN_ID,
				sessionId: SESSION_ID,
				threadId: THREAD_ID,
				projectId: PROJECT_ID,
				tenantId: TENANT_ID,
				resumeHandler: async () => ({ action: 'approve_tools' }),
			},
			(e) => {
				events.push(e)
			},
		)

		expect(run.status).toBe('completed')
		expect(run.result).toBe('all done')
		expect(calls).toEqual(['noop'])
		expect(events.map((e) => e.type)).not.toContain('run_paused')

		// Nothing was persisted: the fast path pays no durability cost. A handler that
		// answers in-process holds the process, and if it dies mid-thought the decision
		// dies with it — which is the honest semantics of a synchronous review, and
		// exactly what it was before.
		const store = new RunDiskStore({ baseDir: runsDir(cwd) })
		await store.initRun(RUN_ID)
		const checkpoints = await store.listCheckpoints()
		expect(checkpoints.length).toBeGreaterThan(0)
		expect(checkpoints.every((cp) => cp.pendingDecision === undefined)).toBe(true)
	})

	it('an ABSENT handler parks rather than approving — fail-closed', async () => {
		const cwd = tmp()
		const calls: string[] = []

		const run = await drainQueryWithoutHandler(cwd, calls)

		expect(run.status).toBe('awaiting_input')
		expect(calls).toEqual([]) // nothing ran. Nobody was there to authorize it.
	})
})

describe('a decision that has let go of the block does NOT keep the repair suppressed', () => {
	it('settled → the history IS repaired, so no provider ever sees an unanswered tool-call block', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// First resume: the decision is applied and reaches `settled`.
		await drive({
			cwd,
			provider: stoppingRecordingProvider(),
			tools: registryWith(noopTool(calls)),
			decision: { action: 'continue' },
			resumeFromCheckpoint: checkpointId,
		})
		const settled = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(settled?.state).toBe('settled')

		// Now resume from that SAME (now stale) checkpoint again. Its messages are still
		// the pre-execution ones — the assistant's tool-call block with no results — but the
		// decision has let go of it: the real results live in a later checkpoint, and this
		// is a fork whose tools did not run in its own timeline.
		//
		// So the repair MUST come back. Suppressing it here would hand the provider an
		// assistant tool-call block with no results at all — which is precisely what the
		// repair exists to prevent, and a strictly worse failure than the one D2 fixed.
		const provider = stoppingRecordingProvider()
		await drive({
			cwd,
			provider,
			tools: registryWith(noopTool(calls)),
			decision: { action: 'continue' },
			resumeFromCheckpoint: checkpointId,
		})

		const handed = provider.seen[0] ?? []
		const answered = handed
			.filter((m) => m.role === 'tool')
			.map((m) => (m as { toolCallId: string }).toolCallId)
		const asked = handed
			.filter((m) => m.role === 'assistant')
			.flatMap((m) =>
				((m as { toolCalls?: Array<{ id: string }> }).toolCalls ?? []).map((c) => c.id),
			)

		expect(asked).toContain('call_1')
		for (const id of asked) {
			expect(answered).toContain(id) // every call answered — provider-valid
		}
		// And it was answered by the REPAIR, because in this fork the tool never ran.
		const contents = handed.filter((m) => m.role === 'tool').map((m) => String(m.content))
		expect(contents.some((c) => c.includes(REPAIR_PLACEHOLDER))).toBe(true)
	})
})

describe('a decision may only be applied to the block it was actually raised for', () => {
	it('refuses to execute when the decision names calls that are not the checkpoint’s block', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// Tamper the persisted decision so it names a call the history does not contain.
		// A record where the decision and the block disagree is a record describing two
		// different runs, and executing the block on the strength of that approval would be
		// executing a batch nobody reviewed.
		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		await store.updateCheckpoint(checkpointId, (cp) => {
			const pd = cp.pendingDecision
			if (!pd || pd.request.type !== 'tool_review') throw new Error('bad fixture')
			return {
				...cp,
				pendingDecision: {
					...pd,
					request: {
						...pd.request,
						toolCalls: [{ id: 'call_999', name: 'noop', input: {}, isDestructive: false }],
					},
				},
			}
		})

		const events: RunEvent[] = []
		const run = await drive({
			cwd,
			provider: stoppingRecordingProvider(),
			tools: registryWith(noopTool(calls)),
			decision: { action: 'continue' },
			resumeFromCheckpoint: checkpointId,
		}).then((d) => {
			events.push(...d.events)
			return d.run
		})

		expect(calls).toEqual([]) // NOTHING ran
		expect(run.status).toBe('failed')
		expect(String(run.lastError)).toContain('nobody reviewed')
	})
})

describe('the other two doors onto the same bug are closed too', () => {
	it('prepareReplayState forks AWAY from a live decision, and says so', async () => {
		const cwd = tmp()
		const { checkpointId, baseDir, decision } = await pauseAtReview(cwd, [])

		const prepared = await prepareReplayState({
			baseDir,
			runId: RUN_ID,
			fromCheckpoint: checkpointId,
		})

		// A replay is a FORK, not a resume. The decision — its token, its journal — belongs
		// to the original run, and this fork has no authority to redeem it. So the fork gets
		// a timeline in which the human never answered and the tool never ran, which is what
		// the repaired history honestly says.
		const toolResults = prepared.messages.filter((m) => m.role === 'tool')
		expect(toolResults.map((m) => String(m.content))).toEqual([
			expect.stringContaining(REPAIR_PLACEHOLDER),
		])

		// What it must NOT do is take that silently. A caller forking off a paused run
		// learns that it forked away from a live decision rather than quietly receiving a
		// run whose tool call was destroyed.
		expect(prepared.discardedPendingDecision).toBe(decision.requestId)

		// The original decision is untouched and still answerable — the fork did not
		// consume it.
		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('pending')
		expect(after?.resumeToken).toBe(decision.resumeToken)
	})

	it('projectEmergencyToCheckpoint REFUSES a dump taken mid-pause, and names the real checkpoint', () => {
		const dump = {
			id: 'esave_abc' as never,
			runId: RUN_ID,
			messages: [],
			tokenUsage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			currentIteration: 1,
			startedAt: 1,
			savedAt: 2,
			processSignal: 'SIGTERM',
			awaitingDecision: { checkpointId: 'cp_real' as const, requestId: 'dreq_x' as const },
		}

		// The dump carries the run, not the checkpoint — so it does NOT carry the decision,
		// and projecting it would hand the resume path an unowned dangling tool call for
		// `repairDanglingMessages` to destroy. That is the ses_017 bug through a third door.
		// The real review checkpoint is on disk with the decision intact, and the dump names
		// it, so refusing with a pointer beats producing a corrupted fork.
		let thrown: unknown
		try {
			projectEmergencyToCheckpoint(dump)
		} catch (err) {
			thrown = err
		}
		expect(thrown).toBeInstanceOf(EmergencyProjectionUnresumableError)
		expect((thrown as EmergencyProjectionUnresumableError).checkpointId).toBe('cp_real')
		expect(String(thrown)).toContain('cp_real')
	})

	it('projectEmergencyToCheckpoint still works for an ordinary crash dump', () => {
		const dump = {
			id: 'esave_abc' as never,
			runId: RUN_ID,
			messages: [],
			tokenUsage: {
				promptTokens: 1,
				completionTokens: 1,
				totalTokens: 2,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
			currentIteration: 3,
			startedAt: 1,
			savedAt: 5,
			processSignal: 'SIGTERM',
		}

		const cp = projectEmergencyToCheckpoint(dump)
		expect(cp.id).toBe('cp_emergency_abc')
		expect(cp.pendingDecision).toBeUndefined()
	})
})

/** `query()` with no `resumeHandler` at all — the absent-handler switch. */
async function drainQueryWithoutHandler(cwd: string, calls: string[]): Promise<Run> {
	const gen = query({
		provider: recordingProvider(),
		tools: registryWith(noopTool(calls)),
		runConfig: { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 },
		agentId: 'agent_test',
		agentName: 'Test',
		workingDirectory: cwd,
		messages: [],
		runId: RUN_ID,
		sessionId: SESSION_ID,
		threadId: THREAD_ID,
		projectId: PROJECT_ID,
		tenantId: TENANT_ID,
	})
	let step = await gen.next()
	while (!step.done) step = await gen.next()
	return step.value
}
