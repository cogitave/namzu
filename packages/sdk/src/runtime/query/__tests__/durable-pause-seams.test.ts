// Current-code invariants asserted (2026-07-13, ses_017 post-review seam fixes):
//
// The durable pause survived a human. Its SEAMS did not. Each describe below is one
// of the ten defects the 32-agent review confirmed, reproduced first and pinned here.
//
//   F1 — the resume token was not single-use. `resumeDecision` news up its own
//        RunDiskStore, so `updateCheckpoint`'s per-INSTANCE lock serialised nothing:
//        two concurrent redemptions both saw `pending`, both wrote, and both drove a
//        resume — executing an approved destructive batch TWICE. Single-use is now a
//        property of the DURABLE record (an exclusive-create claim marker), not of an
//        in-memory Map.
//   F2 — a pause whose batch contained a gate-denied call could NEVER be resumed.
//        `findReviewedBlock` demanded set-EQUALITY against an assistant block that
//        still carries the denied call, so the resumed run hard-failed and the token
//        was spent. The decision's ids are now a SUBSET of the block's.
//   F3 — cancel never reached the durable decision. A cancelled paused run was still
//        resumable and its tools still ran.
//   F4 — `awaiting_input` only reached run.json in finalize(), so a crash between
//        persisting the decision and the generator returning bricked the run at
//        `idle` with a live pending decision.
//   F5 — a `pause` at the PLAN gate parked the run with NO decision persisted:
//        neither terminal nor resumable.
//   F6 — `DecisionLocator` had no `parentRunId`, so a paused CHILD run was looked for
//        at `baseDir/<childRunId>` instead of `baseDir/<parent>/children/<child>`.
//   F7 — the sandbox is torn down when the run parks, and the approved batch then
//        runs in a FRESH one. It cannot be otherwise (a Sandbox cannot be reattached),
//        so the model is TOLD, rather than left to reason from a phantom filesystem.
//   F9 — a parked `iteration_checkpoint` resumed by skipping the interrupted
//        iteration's tail: no advisory, no `iteration_end`, no `iteration_completed`.
//   F10 — the pause emitted `tool_review_completed { decision: 'rejected' }` before
//        parking, telling every consumer the review was REJECTED while it was still
//        pending — and then contradicted itself on resume.
import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { RunDiskStore } from '../../../store/run/disk.js'
import type { HITLDecisionRequest, HITLResumeDecision } from '../../../types/hitl/index.js'
import type {
	CheckpointId,
	ProjectId,
	RunId,
	SessionId,
	TenantId,
	ThreadId,
} from '../../../types/ids/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import type { Sandbox, SandboxProvider } from '../../../types/sandbox/index.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { DecisionAlreadyResolvedError, RunNotResumableError } from '../decision/errors.js'
import { cancelRun, readPendingDecision, resumeDecision } from '../decision/resume.js'
import { drainQuery } from '../index.js'

const RUN_ID = 'run_seams' as RunId
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

const RUN_CONFIG = { model: 'm', tokenBudget: 1_000_000, timeoutMs: 600_000, maxIterations: 5 }

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-seams-'))
}

function runsDir(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

/** A provider that asks for the given tool calls once, then ends the turn. */
function providerAsking(
	toolCalls: Array<{ id: string; name: string; args: string }>,
): LLMProvider & { seen: ChatCompletionParams['messages'][] } {
	const seen: ChatCompletionParams['messages'][] = []
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
						content: 'working',
						toolCalls: toolCalls.map((tc) => ({
							id: tc.id,
							type: 'function' as const,
							function: { name: tc.name, arguments: tc.args },
						})),
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

/** Ends the turn immediately — the resume leg's provider. */
function stoppingProvider(): LLMProvider & { seen: ChatCompletionParams['messages'][] } {
	const seen: ChatCompletionParams['messages'][] = []
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

function tool(name: string, calls: string[]): ToolDefinition<Record<string, never>> {
	return {
		name,
		description: name,
		inputSchema: z.object({}).passthrough() as never,
		async execute() {
			calls.push(name)
			return { success: true, output: `${name}:ok` }
		},
	}
}

function registryOf(...tools: ToolDefinition<Record<string, never>>[]): ToolRegistry {
	const registry = new ToolRegistry()
	for (const t of tools) registry.register(t as unknown as ToolDefinition)
	return registry
}

function pausedCheckpointId(events: RunEvent[]): CheckpointId {
	const paused = events.find((e) => e.type === 'run_paused')
	if (!paused) throw new Error('run never paused')
	return (paused as { checkpointId: CheckpointId }).checkpointId
}

interface DriveOpts {
	cwd: string
	provider: LLMProvider
	tools: ToolRegistry
	handler: (req: HITLDecisionRequest) => Promise<HITLResumeDecision>
	resumeFromCheckpoint?: CheckpointId
	verificationGate?: Parameters<typeof drainQuery>[0]['verificationGate']
	pluginManager?: Parameters<typeof drainQuery>[0]['pluginManager']
	sandboxProvider?: SandboxProvider
	runId?: RunId
	parentRunId?: RunId
}

async function drive(opts: DriveOpts): Promise<{ run: Run; events: RunEvent[] }> {
	const events: RunEvent[] = []
	const run = await drainQuery(
		{
			provider: opts.provider,
			tools: opts.tools,
			runConfig: RUN_CONFIG,
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: opts.runId ?? RUN_ID,
			parentRunId: opts.parentRunId,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: opts.resumeFromCheckpoint,
			verificationGate: opts.verificationGate,
			pluginManager: opts.pluginManager,
			sandboxProvider: opts.sandboxProvider,
			resumeHandler: opts.handler,
		},
		(e) => {
			events.push(e)
		},
	)
	return { run, events }
}

const pauseHandler = async (): Promise<HITLResumeDecision> => ({
	action: 'pause',
	reason: 'stepping away',
})
const continueHandler = async (): Promise<HITLResumeDecision> => ({ action: 'continue' })

// ───────────────────────────────────────────────────────────────────────────
// F1 — the resume token is single-use, durably
// ───────────────────────────────────────────────────────────────────────────

describe('F1: the resume token is single-use against the DURABLE record, not an in-memory lock', () => {
	it('two concurrent redemptions of one token: exactly one wins, the loser is refused', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'charge', args: '{}' }]),
			tools: registryOf(tool('charge', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')

		// Two clients submit the same token at the same instant — a double-click, a
		// retried request, two workers draining one queue. Each builds its OWN store, so
		// the per-instance checkpoint lock does not exist between them.
		const redeem = () =>
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			})

		const settled = await Promise.allSettled([redeem(), redeem()])
		const fulfilled = settled.filter((s) => s.status === 'fulfilled')
		const rejected = settled.filter((s) => s.status === 'rejected')

		// EXACTLY ONE prepared resume. Two would mean two callers each drive
		// `query({ resumeFromCheckpoint })` and the approved batch runs twice.
		expect(fulfilled).toHaveLength(1)
		expect(rejected).toHaveLength(1)

		// And the loser learns WHY, in the vocabulary the decisions route branches on —
		// not an opaque `ENOENT ... rename('cp_x.json.tmp')` from two writers colliding
		// on one fixed temp path, which is a 500 and indistinguishable from a fault.
		const err = (rejected[0] as PromiseRejectedResult).reason
		expect(err).toBeInstanceOf(DecisionAlreadyResolvedError)
		expect((err as DecisionAlreadyResolvedError).outcome).toEqual({ action: 'approve_tools' })
	})

	it('a redemption that loses the race is refused even when it carries a DIFFERENT outcome', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'charge', args: '{}' }]),
			tools: registryOf(tool('charge', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')

		const settled = await Promise.allSettled([
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'reject_tools', feedback: 'no' },
			}),
		])

		expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1)
		const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult
		expect(rejected.reason).toBeInstanceOf(DecisionAlreadyResolvedError)

		// The winner's outcome is the one on the record. A second answer never overwrites
		// the one the run is about to act on.
		const after = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		expect(after?.state).toBe('resolved')
		expect(after?.outcome).toEqual(
			(
				settled.find((s) => s.status === 'fulfilled') as PromiseFulfilledResult<
					Awaited<ReturnType<typeof resumeDecision>>
				>
			).value.decision.outcome,
		)
	})
})

describe('F1 (one layer down): the right to DISPATCH an answered batch is claimed too', () => {
	it('a second resume of one resolved decision refuses to run the batch again', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'charge', args: '{}' }]),
			tools: registryOf(tool('charge', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// Single-use is a property of the TOKEN, and exactly one caller was handed a
		// prepared resume. Nothing about that stops the resume itself from being driven
		// twice — a retried request, a job delivered twice by a queue, an operator
		// re-driving one that looked stuck. Here another process got there first and is
		// executing the batch: its execution claim is on disk.
		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		const first = await store.claimDecision(
			checkpointId,
			{ requestId: decision.requestId, at: Date.now(), claimedBy: 'the other process' },
			'execution',
		)
		expect(first).toBeNull() // that process won it

		const { run } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('charge', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
		})

		// The card is charged ONCE. This resume refused rather than dispatching a batch
		// somebody else is already dispatching — and it says so, loudly, because two
		// concurrent resumes of one decision is a caller bug and the safe reading of a bug
		// is to stop.
		expect(calls).toEqual([])
		expect(run.status).toBe('failed')
		expect(String(run.lastError)).toContain('already being executed')
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F2 — a gate-denied call in the batch must not brick the pause
// ───────────────────────────────────────────────────────────────────────────

describe('F2: a pause whose batch had a gate-denied call is still resumable', () => {
	const gate = {
		enabled: true,
		rules: [{ type: 'deny_by_name' as const, toolNames: ['danger'] }],
		allowReadOnlyTools: false,
		denyDangerousPatterns: false,
		logDecisions: false,
	}

	it('resumes, runs the approved call, and does NOT hard-fail the run', async () => {
		const cwd = tmp()
		const calls: string[] = []

		// The model asks for [danger, noop]. The GATE denies `danger` before the human
		// sees it, so the review — and the persisted decision — names only `noop`, while
		// the assistant message still carries both.
		const { run: paused, events } = await drive({
			cwd,
			provider: providerAsking([
				{ id: 'call_bad', name: 'danger', args: '{}' },
				{ id: 'call_ok', name: 'noop', args: '{}' },
			]),
			tools: registryOf(tool('danger', calls), tool('noop', calls)),
			handler: pauseHandler,
			verificationGate: gate,
		})
		expect(paused.status).toBe('awaiting_input')
		expect(calls).toEqual([])

		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')

		// The decision names ONE call; the block has TWO. That is not a corrupt record —
		// it is what a partial gate denial looks like.
		const req = decision.request as { toolCalls: Array<{ id: string }> }
		expect(req.toolCalls.map((tc) => tc.id)).toEqual(['call_ok'])

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const { run, events: events2 } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('danger', calls), tool('noop', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
			verificationGate: gate,
		})

		// The human's approved tool RAN. The run did not fail.
		expect(calls).toEqual(['noop'])
		expect(run.status).toBe('completed')
		expect(events2.map((e) => e.type)).not.toContain('run_failed')

		// The gate-denied call keeps the denial it got at PAUSE time — it is not re-run,
		// not re-reviewed, and not answered twice.
		const denied = run.messages.filter(
			(m) => m.role === 'tool' && (m as { toolCallId: string }).toolCallId === 'call_bad',
		)
		expect(denied).toHaveLength(1)
		expect(String(denied[0]?.content)).toContain('blocked by verification gate')

		// Every call in the block is answered exactly once — provider-valid.
		const answered = run.messages
			.filter((m) => m.role === 'tool')
			.map((m) => (m as { toolCallId: string }).toolCallId)
		expect([...answered].sort()).toEqual(['call_bad', 'call_ok'])
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F3 — cancel reaches the durable decision
// ───────────────────────────────────────────────────────────────────────────

describe('F3: cancelling a suspended run reaches its durable decision', () => {
	async function park(cwd: string, calls: string[]) {
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'deploy', args: '{}' }]),
			tools: registryOf(tool('deploy', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')
		return { checkpointId, baseDir, decision }
	}

	it('transitions the decision AND the run’s persisted status to cancelled', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await park(cwd, calls)

		const outcome = await cancelRun({ baseDir, runId: RUN_ID })
		expect(outcome.status).toBe('cancelled')
		expect(outcome.cancelledDecisions).toEqual([checkpointId])

		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		expect((await store.readRunMeta())?.status).toBe('cancelled')
		expect((await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId }))?.state).toBe(
			'cancelled',
		)
	})

	it('refuses the token afterwards — a leaked token cannot resume a cancelled run', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await park(cwd, calls)

		await cancelRun({ baseDir, runId: RUN_ID })

		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).rejects.toThrow(RunNotResumableError)
		expect(calls).toEqual([])
	})

	it('and query() refuses to resume the cancelled run even from the checkpoint itself', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await park(cwd, calls)

		await cancelRun({ baseDir, runId: RUN_ID })

		// The last door: a caller who still holds the checkpoint id and drives `query()`
		// directly. A cancelled run is unresumable BY CONSTRUCTION, so the tool the user
		// believes they cancelled does not run.
		const { run } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('deploy', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
		})

		expect(calls).toEqual([])
		expect(run.status).toBe('failed')
		expect(String(run.lastError)).toContain('cancelled')
	})

	it('is idempotent, and leaves an already-resolved decision alone', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir, decision } = await park(cwd, calls)

		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// The reviewer answered first. Cancelling the run still cancels the RUN, but it
		// does not rewrite a decision whose tools may already be in flight — that would
		// lose the journal that says which.
		const outcome = await cancelRun({ baseDir, runId: RUN_ID })
		expect(outcome.status).toBe('cancelled')
		expect(outcome.cancelledDecisions).toEqual([])
		expect((await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId }))?.state).toBe(
			'resolved',
		)

		// Idempotent.
		expect((await cancelRun({ baseDir, runId: RUN_ID })).status).toBe('cancelled')
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F4 — the suspension is persisted when it is DECIDED, not at finalize
// ───────────────────────────────────────────────────────────────────────────

describe('F4: awaiting_input reaches run.json the moment the run parks', () => {
	it('a generator abandoned right after run_paused still leaves a resumable run on disk', async () => {
		const cwd = tmp()
		const calls: string[] = []

		// Consume the stream up to `run_paused` and then STOP — the process died, the
		// container was recycled, the request was cancelled. `finalize()` never runs.
		const { query } = await import('../index.js')
		const gen = query({
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			runConfig: RUN_CONFIG,
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: cwd,
			messages: [],
			runId: RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeHandler: pauseHandler,
		})

		let checkpointId: CheckpointId | undefined
		for await (const event of gen) {
			if (event.type === 'run_paused') {
				checkpointId = (event as { checkpointId: CheckpointId }).checkpointId
				break // ← the process stops here. Nothing below this line ever runs.
			}
		}
		if (!checkpointId) throw new Error('run never paused')

		const baseDir = runsDir(cwd)
		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		const meta = await store.readRunMeta()

		// The decision is on disk AND the run says it is waiting for one. Before the fix
		// the decision was durable but `run.json` still read `idle`, so `resumeDecision`
		// threw `RunNotResumableError(runId, 'idle')` forever: a run that is not terminal,
		// holds an answerable question, and has no path to answer it.
		expect(meta?.status).toBe('awaiting_input')
		expect(meta?.awaitingDecision?.checkpointId).toBe(checkpointId)

		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')

		// And it really is answerable — the whole point.
		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).resolves.toBeDefined()
	})

	it('a resumed segment that dies before it re-parks does not leave the run at `idle`', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)

		// Resume WITHOUT redeeming, and die mid-segment — `run_resuming` is emitted right
		// after `init()`, which is the window. Nobody has answered yet, so the decision is
		// still `pending` and still the only thing that can un-park this run.
		//
		// `init()` re-runs on every resumed segment and a fresh `RunPersistence` starts at
		// `idle`, so it used to write `idle` straight over the persisted `awaiting_input`.
		// A segment that then died here — before the dispatcher re-parked and re-wrote it —
		// left a run that is not terminal, holds an answerable decision, and that
		// `resumeDecision` refuses forever with `RunNotResumableError(runId, 'idle')`.
		const { query } = await import('../index.js')
		const gen = query({
			provider: stoppingProvider(),
			tools: registryOf(tool('noop', calls)),
			runConfig: RUN_CONFIG,
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
			resumeHandler: pauseHandler,
		})
		for await (const event of gen) {
			if (event.type === 'run_resuming') break // ← the process stops here.
		}

		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		expect((await store.readRunMeta())?.status).toBe('awaiting_input')

		// Still answerable. The last durable truth about a parked run survives until the
		// segment replaces it with a REAL outcome.
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')
		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).resolves.toBeDefined()
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F5 — the plan gate has no third state
// ───────────────────────────────────────────────────────────────────────────

describe('F5: a pause at the plan gate does not park a run nothing can answer', () => {
	/** The parts of an IterationContext `handleHITLDecision` actually touches. */
	function stubCtx() {
		const attached: unknown[] = []
		const suspended: unknown[] = []
		const stopReasons: string[] = []
		const events: RunEvent[] = []
		const ctx = {
			runMgr: {
				id: RUN_ID,
				status: 'running',
				async markSuspended(ref?: unknown) {
					suspended.push(ref ?? null)
					this.status = 'awaiting_input'
				},
				markCancelled() {
					this.status = 'cancelled'
				},
				setStopReason(reason: string) {
					stopReasons.push(reason)
				},
			},
			checkpointMgr: {
				async attachPendingDecision(...args: unknown[]) {
					attached.push(args)
				},
			},
			planManager: { active: undefined, approve() {}, startExecution() {} },
			async emitEvent(event: RunEvent) {
				events.push(event)
			},
			*drainPending(): Generator<RunEvent> {},
			log: { info() {}, warn() {}, error() {}, debug() {} },
		}
		return { ctx, attached, suspended, stopReasons, events }
	}

	it('ENDS the run instead of parking it with no decision to answer', async () => {
		const { handleHITLDecision } = await import('../iteration/phases/context.js')
		const { ctx, attached, suspended, stopReasons } = stubCtx()

		const request: HITLDecisionRequest = {
			type: 'plan_approval',
			requestId: 'dreq_plan' as never,
			runId: RUN_ID,
			checkpointId: 'cp_plan_1' as CheckpointId,
			plan: { planId: 'plan_1' as never, title: 't', steps: [], summary: 's' },
		}

		const gen = handleHITLDecision(
			ctx as never,
			{ action: 'pause', reason: 'stepping away' },
			request,
			'plan_gate',
		)
		let step = await gen.next()
		while (!step.done) step = await gen.next()

		// A plan pause CANNOT be durable: the checkpoint captures no PlanManager, so a
		// persisted plan decision would have nothing to resume into. Parking anyway
		// produced a run that was neither terminal nor resumable, and `deriveStatus`
		// reported the whole Session as waiting on a human, forever. It stops instead —
		// which is what it did before ses_017, and is honest.
		expect(step.value).toBe('stop')
		expect(suspended).toEqual([])
		expect(attached).toEqual([])
		expect(ctx.runMgr.status).not.toBe('awaiting_input')
		expect(stopReasons).toContain('paused')
	})

	it('still parks an iteration_checkpoint durably — that one CAN be resumed', async () => {
		const { handleHITLDecision } = await import('../iteration/phases/context.js')
		const { ctx, attached, suspended } = stubCtx()

		const request: HITLDecisionRequest = {
			type: 'iteration_checkpoint',
			requestId: 'dreq_iter' as never,
			runId: RUN_ID,
			checkpointId: 'cp_iter_1' as CheckpointId,
			summary: {
				iteration: 1,
				messageCount: 3,
				tokenUsage: USAGE,
				costInfo: {
					inputCostPer1M: 0,
					outputCostPer1M: 0,
					totalCost: 0,
					cacheDiscount: 0,
				},
			},
		}

		const gen = handleHITLDecision(
			ctx as never,
			{ action: 'pause', reason: 'checking in' },
			request,
			'iteration_checkpoint',
		)
		let step = await gen.next()
		while (!step.done) step = await gen.next()

		expect(step.value).toBe('suspend')
		expect(attached).toHaveLength(1)
		expect(suspended).toHaveLength(1)
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F6 — a paused CHILD run is addressed at its own directory
// ───────────────────────────────────────────────────────────────────────────

describe('F6: a suspended child run can be found, answered and cancelled', () => {
	const CHILD = 'run_child' as RunId
	const PARENT = 'run_parent' as RunId

	it('locates the child’s decision under <parent>/children/<child>', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			handler: pauseHandler,
			runId: CHILD,
			parentRunId: PARENT,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)

		// The child's record lives under its parent. Without `parentRunId` on the locator
		// the read resolves `baseDir/<childRunId>` — a directory it then CREATES, empty —
		// and the decision is invisible.
		const decision = await readPendingDecision({
			baseDir,
			runId: CHILD,
			parentRunId: PARENT,
			checkpointId,
		})
		expect(decision?.state).toBe('pending')

		await expect(
			resumeDecision({
				baseDir,
				runId: CHILD,
				parentRunId: PARENT,
				checkpointId,
				resumeToken: decision?.resumeToken ?? '',
				decision: { action: 'approve_tools' },
			}),
		).resolves.toBeDefined()

		const raw = await readFile(join(baseDir, PARENT, 'children', CHILD, 'run.json'), 'utf-8')
		expect(JSON.parse(raw).status).toBe('awaiting_input')
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F7 — the sandbox does not survive the pause, and the model is told
// ───────────────────────────────────────────────────────────────────────────

function fakeSandboxProvider(created: string[], destroyed: string[]): SandboxProvider {
	let n = 0
	return {
		id: 'fake-sandbox',
		name: 'Fake',
		environment: 'basic',
		async create(): Promise<Sandbox> {
			const id = `sbx_${++n}`
			created.push(id)
			return {
				id: id as Sandbox['id'],
				status: 'ready',
				rootDir: `/tmp/${id}`,
				environment: 'basic',
				async exec() {
					return { exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1 }
				},
				async writeFile() {},
				async readFile() {
					return Buffer.from('')
				},
				async destroy() {
					destroyed.push(id)
				},
			}
		},
	}
}

describe('F7: a suspended run’s sandbox is gone, and the resumed batch is told so', () => {
	it('destroys the sandbox on suspend and tells the model the new one is EMPTY', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const created: string[] = []
		const destroyed: string[] = []

		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'deploy', args: '{}' }]),
			tools: registryOf(tool('deploy', calls)),
			handler: pauseHandler,
			sandboxProvider: fakeSandboxProvider(created, destroyed),
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)

		// A Sandbox cannot be reattached — `SandboxProvider.create()` mints a fresh root
		// and `destroy()` removes it — so a pause that outlives the process CANNOT keep
		// it. Holding it open instead would strand a temp tree and its processes for as
		// long as a human takes to answer, which is worse. It goes.
		expect(created).toEqual(['sbx_1'])
		expect(destroyed).toEqual(['sbx_1'])

		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const { run } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('deploy', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
			sandboxProvider: fakeSandboxProvider(created, destroyed),
		})

		expect(calls).toEqual(['deploy'])

		// The approved tool ran in a sandbox that has NONE of the state the iterations
		// before the pause built. Silence here is what makes the model reason from a
		// filesystem that does not exist; it is told instead, right after the results it
		// has to interpret.
		const note = run.messages.find((m) => String(m.content ?? '').includes('fresh sandbox'))
		expect(note).toBeDefined()
		expect(String(note?.content)).toContain('NOT carried across the pause')
	})

	it('says nothing when the run has no sandbox', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			handler: pauseHandler,
		})
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const { run } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('noop', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
		})

		expect(run.messages.some((m) => String(m.content ?? '').includes('fresh sandbox'))).toBe(false)
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F9 — a parked iteration checkpoint finishes the iteration it interrupted
// ───────────────────────────────────────────────────────────────────────────

describe('F9: resuming an iteration_checkpoint completes the interrupted iteration’s tail', () => {
	it('fires iteration_end and iteration_completed for the iteration whose tools ran', async () => {
		const cwd = tmp()
		const calls: string[] = []

		// Approve the tools, then park at the ITERATION CHECKPOINT that follows them. The
		// tools have already run; everything downstream of them belongs to iteration 1.
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			handler: async (req) =>
				req.type === 'iteration_checkpoint'
					? { action: 'pause', reason: 'checking in' }
					: { action: 'approve_tools' },
		})
		expect(calls).toEqual(['noop'])
		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)

		// The pause cut iteration 1 off after its tools: no iteration_completed for it.
		expect(
			events
				.filter((e) => e.type === 'iteration_completed')
				.map((e) => (e as { iteration: number }).iteration),
		).not.toContain(1)

		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('an iteration_checkpoint pause persisted no decision')
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'continue' },
		})

		const hooks: string[] = []
		const pluginManager = {
			async executeHooks(event: string) {
				hooks.push(event)
				return []
			},
		} as unknown as NonNullable<Parameters<typeof drainQuery>[0]['pluginManager']>

		const { events: events2 } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('noop', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
			pluginManager,
		})

		// The interrupted iteration's TAIL runs. Without it a plugin that reconciles state
		// on `iteration_end` never sees the iteration whose tools actually ran, and every
		// client pairing iteration.started with iteration.completed is left hanging for
		// iteration 1 forever.
		const completed = events2
			.filter((e) => e.type === 'iteration_completed')
			.map((e) => (e as { iteration: number }).iteration)
		expect(completed).toContain(1)
		expect(hooks).toContain('iteration_end')

		// The tool did NOT run a second time, and the iteration was not re-announced.
		expect(calls).toEqual(['noop'])
		expect(
			events2
				.filter((e) => e.type === 'iteration_started')
				.map((e) => (e as { iteration: number }).iteration),
		).not.toContain(1)
	})
})

// ───────────────────────────────────────────────────────────────────────────
// F10 — the pause does not lie on the wire
// ───────────────────────────────────────────────────────────────────────────

describe('F10: a pause does not report the review as REJECTED', () => {
	it('emits no tool_review_completed until the review is actually completed', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { events } = await drive({
			cwd,
			provider: providerAsking([{ id: 'call_1', name: 'noop', args: '{}' }]),
			tools: registryOf(tool('noop', calls)),
			handler: pauseHandler,
		})

		// A UI that closes its approval dialog and records "rejected" on `review.completed`
		// — the only sane reading of that event — told the user their tools were DENIED
		// while the batch sat on disk waiting for them.
		expect(events.map((e) => e.type)).toContain('tool_review_requested')
		expect(events.map((e) => e.type)).not.toContain('tool_review_completed')
		expect(events.map((e) => e.type)).toContain('run_paused')

		const checkpointId = pausedCheckpointId(events)
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no decision persisted')
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		const { events: events2 } = await drive({
			cwd,
			provider: stoppingProvider(),
			tools: registryOf(tool('noop', calls)),
			handler: continueHandler,
			resumeFromCheckpoint: checkpointId,
		})

		// The review completes exactly ONCE, on the resume, with the outcome the human
		// actually chose.
		const completions = events2.filter((e) => e.type === 'tool_review_completed')
		expect(completions).toHaveLength(1)
		expect(completions[0]).toMatchObject({ decision: 'approved' })
	})
})
