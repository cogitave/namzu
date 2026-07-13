// Current-code invariants asserted (2026-07-13, ses_017 G1/G2):
//
// TWO GAPS, and they are the last two between "durable pause" and a claim we can defend.
//
// G1 — a parked run had no owner. Nothing stopped two processes from driving
// `query({ resumeFromCheckpoint })` for one run at the same time. Both ran `init()`, both
// wrote `run.json`, both wrote `messages.json`; the histories diverged and the last writer
// won. The double-EXECUTION of a reviewed batch was already closed (the dispatch right is
// claimed on disk), but the RECORD was not: the loser's segment could still overwrite the
// winner's history with its own. And a crash mid-segment left the run reading
// `awaiting_input` for the rest of its life — a crashed segment and a parked one were the
// same thing on disk.
//
// G2 — `query({ resumeFromCheckpoint })` refused only a `cancelled` run. A `completed` or
// `failed` one it re-drove happily, under the same id, overwriting its `run.json` and its
// history. "Resume this run" and "fork a new run from its checkpoint" were one door with
// one id.
//
//   - A segment acquires the run's LEASE before it writes anything and holds it until it
//     parks, finishes or dies. A second segment is refused with `RunLeaseHeldError` and
//     writes NOTHING — asserted byte-for-byte, not by inspecting a status.
//   - A refusal is raised in ADMISSION: outside `query()`'s try, before the span, before
//     the first write. Inside it, every refusal went through `handleError` → `markFailed`
//     → `finalize()` → PERSIST, so refusing to resume a run rewrote its `run.json` to
//     `failed` and its `messages.json` to `[]`. The guard destroyed what it guarded.
//   - The lease EXPIRES. A crashed holder's run is resumable again after its TTL, and the
//     takeover bumps the fencing token, so the crashed holder cannot come back and write.
//   - `awaiting_input` + a FREE lease is a parked run. A HELD lease is a live segment. A
//     STALE lease is a crashed one. Three states, three readings.
//   - RESUME continues THE run: same id, same ledger, non-terminal only. A `completed` or
//     `failed` run is refused with `RunNotResumableError` naming the status it found.
//   - FORK starts a NEW run: new id, provenance on its own `run.json` (`replayOf`), and the
//     source run's record is byte-identical afterwards.
//   - The in-process `ResumeHandler` fast path is untouched: it never parks, and it leaves
//     no lease behind.
import { mkdtempSync, readFileSync } from 'node:fs'
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
import { RunLeaseHeldError } from '../../../types/run/lease.js'
import { ForkTargetsSourceRunError } from '../../../types/run/replay.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import { RunNotResumableError } from '../decision/errors.js'
import { readPendingDecision, readRunLease, resumeDecision } from '../decision/resume.js'
import { drainQuery } from '../index.js'
import { prepareForkState } from '../replay/fork.js'

const RUN_ID = 'run_lease_split' as RunId
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Asks for one tool call, then ends. */
function toolThenStop(): LLMProvider {
	let turn = 0
	return {
		id: 'fake',
		name: 'Fake',
		async chat(): Promise<ChatCompletionResponse> {
			turn++
			if (turn === 1) {
				return {
					id: 'r',
					model: 'm',
					message: {
						role: 'assistant',
						content: 'calling',
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

function stopping(text = 'all done'): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: text },
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

/**
 * Ends the turn — but only once the test lets it. This is what makes the concurrency test
 * a test and not a coin flip: the winner is held INSIDE its segment, lease in hand, while
 * the loser tries to take the run.
 */
function barrierProvider(text: string): {
	provider: LLMProvider
	entered: Promise<void>
	release: () => void
} {
	let signalEntered!: () => void
	let release!: () => void
	const entered = new Promise<void>((r) => {
		signalEntered = r
	})
	const gate = new Promise<void>((r) => {
		release = r
	})
	return {
		entered,
		release,
		provider: {
			id: 'fake',
			name: 'Fake',
			async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
				signalEntered()
				await gate
				return {
					id: 'r',
					model: 'm',
					message: { role: 'assistant', content: text },
					finishReason: 'stop',
					usage: USAGE,
				} as ChatCompletionResponse
			},
			// biome-ignore lint/correctness/useYield: stub, never invoked
			async *chatStream() {
				throw new Error('not used')
			},
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
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-g1-'))
}

function runsDir(cwd: string): string {
	return join(
		new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(PROJECT_ID, SESSION_ID),
		'runs',
	)
}

interface DriveOpts {
	cwd: string
	provider: LLMProvider
	tools: ToolRegistry
	decision?: HITLResumeDecision
	resumeFromCheckpoint?: CheckpointId
	runId?: RunId
	events?: RunEvent[]
}

async function drive(opts: DriveOpts): Promise<Run> {
	return drainQuery(
		{
			provider: opts.provider,
			tools: opts.tools,
			runConfig: RUN_CONFIG,
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: opts.cwd,
			messages: [],
			runId: opts.runId ?? RUN_ID,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
			resumeFromCheckpoint: opts.resumeFromCheckpoint,
			resumeHandler: async (_req: HITLDecisionRequest) =>
				opts.decision ?? { action: 'continue' as const },
		},
		(e) => {
			opts.events?.push(e)
		},
	)
}

/** Park a run at a tool review and redeem the token, so it is ready to be resumed. */
async function parkAndApprove(cwd: string, calls: string[]) {
	const events: RunEvent[] = []
	await drive({
		cwd,
		provider: toolThenStop(),
		tools: registryWith(noopTool(calls)),
		decision: { action: 'pause', reason: 'stepping away' },
		events,
	})

	const paused = events.find((e) => e.type === 'run_paused')
	if (!paused) throw new Error('run never paused')
	const checkpointId = (paused as { checkpointId: CheckpointId }).checkpointId
	const baseDir = runsDir(cwd)

	const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
	if (!decision) throw new Error('no pending decision was persisted')

	await resumeDecision({
		baseDir,
		runId: RUN_ID,
		checkpointId,
		resumeToken: decision.resumeToken,
		decision: { action: 'approve_tools' },
	})

	return { checkpointId, baseDir }
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf-8'))
}

describe('a run is driven by one segment at a time', () => {
	it('two concurrent resumes: one takes the lease and proceeds, the other is refused and the history is the WINNER’s', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		const barrier = barrierProvider('winner finished')

		// The winner enters its segment and stops inside the model call, holding the lease.
		// By the time `entered` resolves, the resume dispatcher has already run the approved
		// batch — so this is the exact window in which a second resume used to be able to
		// start, run the loop, and write its own `run.json` and `messages.json` over this
		// one's.
		const winner = drive({
			cwd,
			provider: barrier.provider,
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		})
		await barrier.entered

		const loser = await drive({
			cwd,
			provider: stopping('loser finished'),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		}).catch((e) => e)

		expect(loser).toBeInstanceOf(RunLeaseHeldError)

		barrier.release()
		const won = await winner
		expect(won.status).toBe('completed')

		// The approved batch ran ONCE — the dispatch claim's job — and the record on disk is
		// the winner's, not a merge and not the loser's.
		expect(calls).toEqual(['noop'])
		const messages = JSON.parse(
			readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8'),
		) as Array<{ content?: string }>
		expect(messages.map((m) => m.content)).toContain('winner finished')
		expect(messages.map((m) => m.content)).not.toContain('loser finished')
		expect(readJson(join(baseDir, RUN_ID, 'run.json')).status).toBe('completed')
	})

	it('a refused segment writes NOTHING — the run’s record is byte-identical afterwards', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// A live segment, held open for the duration of this test. (Doing it through the
		// store rather than a second `query()` is what makes the assertion below exact: the
		// only writer that COULD touch these files is the refused one.)
		const live = new RunDiskStore({ baseDir })
		await live.initRun(RUN_ID)
		await live.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'live-segment' })

		const metaBefore = readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')
		const messagesBefore = readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')

		const err = await drive({
			cwd,
			provider: stopping(),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		}).catch((e) => e)

		expect(err).toBeInstanceOf(RunLeaseHeldError)
		expect((err as RunLeaseHeldError).holderId).toBe('live-segment')

		// Not "the status is still awaiting_input" — BYTE-identical. A refusal that writes
		// `status: 'failed'` and an empty `messages.json` over the run it is refusing to
		// touch is not a refusal, and that is precisely what this used to do.
		expect(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).toBe(metaBefore)
		expect(readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')).toBe(messagesBefore)
		expect(calls).toEqual([])
	})

	it('a redemption is refused while a live segment holds the run, and the token is NOT spent', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []
		await drive({
			cwd,
			provider: toolThenStop(),
			tools: registryWith(noopTool(calls)),
			decision: { action: 'pause', reason: 'stepping away' },
			events,
		})
		const checkpointId = (
			events.find((e) => e.type === 'run_paused') as { checkpointId: CheckpointId }
		).checkpointId
		const baseDir = runsDir(cwd)
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no pending decision was persisted')

		const live = new RunDiskStore({ baseDir })
		await live.initRun(RUN_ID)
		await live.acquireLease(RUN_ID, { ttlMs: 60_000, holderId: 'live-segment' })

		await expect(
			resumeDecision({
				baseDir,
				runId: RUN_ID,
				checkpointId,
				resumeToken: decision.resumeToken,
				decision: { action: 'approve_tools' },
			}),
		).rejects.toThrow(RunLeaseHeldError)

		// The answer was NOT recorded, so the token still works once the run is free. A
		// spent token on a run nobody may drive strands the human's decision on disk.
		expect((await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId }))?.state).toBe(
			'pending',
		)
		await live.releaseLease()
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

describe('a lease expires, so a crashed segment does not take the run with it', () => {
	it('a crashed holder’s lease goes stale and the run becomes resumable again', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// A segment that took the run and died: it never released, and it will never renew.
		const crashed = new RunDiskStore({ baseDir })
		await crashed.initRun(RUN_ID)
		const crashedLease = await crashed.acquireLease(RUN_ID, {
			ttlMs: 60,
			holderId: 'crashed-segment',
		})

		// While it is still within its TTL, the run is NOT resumable — we do not know it is
		// dead yet, and guessing wrong is how a batch gets executed twice.
		await expect(
			drive({
				cwd,
				provider: stopping(),
				tools: registryWith(noopTool(calls)),
				resumeFromCheckpoint: checkpointId,
			}),
		).rejects.toThrow(RunLeaseHeldError)

		await sleep(80)

		// …and now the TTL has passed. This is the path that matters — nobody released this
		// lease, and without expiry the run would be unresumable for the rest of its life.
		const run = await drive({
			cwd,
			provider: stopping('resumed after the crash'),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		})

		expect(run.status).toBe('completed')
		expect(calls).toEqual(['noop']) // the approved batch ran, exactly once
		// The takeover bumped the fencing token, which is what fences the crashed holder.
		const lease = await readRunLease({ baseDir, runId: RUN_ID })
		expect(lease.token).toBe(crashedLease.token + 1)
		expect(lease.status).toBe('free') // the new segment released it when it finished
	})
})

describe('parked, live and crashed are three different things', () => {
	it('a parked run reads free; a live segment reads held; a crashed one reads stale', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []
		await drive({
			cwd,
			provider: toolThenStop(),
			tools: registryWith(noopTool(calls)),
			decision: { action: 'pause', reason: 'stepping away' },
			events,
		})
		const baseDir = runsDir(cwd)
		const locator = { baseDir, runId: RUN_ID }

		// PARKED: the run is awaiting_input and NOBODY holds it. This is the one state that
		// means "safe to resume", and it is a conjunction of two facts, not one.
		const store = new RunDiskStore({ baseDir })
		await store.initRun(RUN_ID)
		expect((await store.readRunMeta())?.status).toBe('awaiting_input')
		expect((await readRunLease(locator)).status).toBe('free')

		// LIVE: a segment holds the run. `run.json` still says `awaiting_input` — a segment
		// mid-iteration has not written anything since it started — so the STATUS ALONE
		// would call this parked. It is not: something is driving it.
		const live = new RunDiskStore({ baseDir })
		await live.initRun(RUN_ID)
		await live.acquireLease(RUN_ID, { ttlMs: 60, holderId: 'live-segment' })
		const held = await readRunLease(locator)
		expect(held.status).toBe('held')
		expect(held.lease?.holderId).toBe('live-segment')
		expect((await store.readRunMeta())?.status).toBe('awaiting_input')

		// CRASHED: the same segment, dead. Still not parked — something died here, and an
		// operator told "parked" would go looking for the human who was never asked.
		await sleep(80)
		const stale = await readRunLease(locator)
		expect(stale.status).toBe('stale')
		expect(stale.lease?.holderId).toBe('live-segment')
		expect(stale.expiresAt).toBeLessThan(Date.now())
	})
})

describe('resume continues THE run, and refuses one that is over', () => {
	it.each(['completed', 'cancelled'] as const)(
		'refuses to resume a %s run, naming the status it found',
		async (status) => {
			const cwd = tmp()
			const calls: string[] = []
			const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

			// The run reaches a DECIDED end state: something reached an outcome, or somebody
			// chose to end it. Either way its record means something, and re-driving it under
			// its own id would overwrite that.
			const control = new RunDiskStore({ baseDir })
			await control.initRun(RUN_ID)
			await control.updateRunMeta((meta) => ({ ...meta, status, endedAt: Date.now() }))

			const metaBefore = readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')
			const messagesBefore = readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')

			const err = await drive({
				cwd,
				provider: stopping(),
				tools: registryWith(noopTool(calls)),
				resumeFromCheckpoint: checkpointId,
			}).catch((e) => e)

			expect(err).toBeInstanceOf(RunNotResumableError)
			expect((err as RunNotResumableError).status).toBe(status)
			expect(String(err)).toContain(status)

			// Only `cancelled` used to be refused; a completed run was re-driven under its own
			// id and its record overwritten by the second drive.
			expect(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).toBe(metaBefore)
			expect(readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')).toBe(messagesBefore)
			expect(calls).toEqual([])
		},
	)

	// ses_017 fix-batch L5. Refusing `failed` alongside the other two was a BRICK, and this
	// is the shape of it: the human's answer is already spent, and only a retry under the
	// run's own id can ever dispatch it.
	it('RESUMES a run that failed after the human approved — the token is spent and only this can still dispatch the batch', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// The approved batch has NOT run — the resumed segment died before dispatching it (a
		// provider 529 that exhausted its retries, an OOM, a tool that threw on the way in).
		// `handleError` → `markFailed` → `finalize()` persisted `failed`.
		const control = new RunDiskStore({ baseDir })
		await control.initRun(RUN_ID)
		await control.updateRunMeta((meta) => ({
			...meta,
			status: 'failed',
			lastError: 'provider unavailable',
			endedAt: Date.now(),
		}))
		expect(calls).toEqual([])

		// The decision is still `resolved`: the token was permanently spent when the human
		// answered, and by design it cannot be redeemed a second time. Refuse this retry and
		// the approved batch is undispatchable FOREVER — the run is a brick, and the only
		// escape is a fork, which mints a new id and re-grants the whole lifetime budget.
		expect((await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId }))?.state).toBe(
			'resolved',
		)

		const run = await drive({
			cwd,
			provider: stopping('recovered after the failure'),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		})

		expect(run.status).toBe('completed')
		expect(run.id).toBe(RUN_ID) // the SAME run: same id, same ledger, same index entry
		expect(calls).toEqual(['noop']) // and the batch the human approved finally ran, once
	})

	// ses_017 fix-batch L4 / open question #23. The guard covered the `resumeFromCheckpoint`
	// door and `admitSegment` returned before reaching it on the other one.
	it.each(['completed', 'failed', 'cancelled'] as const)(
		'refuses a plain query({ runId }) against a %s run — a run id names ONE run',
		async (status) => {
			const cwd = tmp()
			const calls: string[] = []
			const { baseDir } = await parkAndApprove(cwd, calls)

			const control = new RunDiskStore({ baseDir })
			await control.initRun(RUN_ID)
			await control.updateRunMeta((meta) => ({ ...meta, status, endedAt: Date.now() }))

			const metaBefore = readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')
			const messagesBefore = readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')

			// No checkpoint — so there is no continuation semantics to offer at all. A retry
			// harness, a redelivered queue job, an API route echoing a client-supplied id: all
			// walked past admission (which returned early), into `init()`, which stamped a
			// fresh `idle` over the finished record, zeroed its usage and its iteration count,
			// and replaced `messages.json` with this segment's history. Note `failed` is
			// refused HERE even though a resume may continue it: without a checkpoint there is
			// nothing to continue from, only a record to overwrite.
			const err = await drive({
				cwd,
				provider: stopping('second drive'),
				tools: registryWith(noopTool(calls)),
			}).catch((e) => e)

			expect(err).toBeInstanceOf(RunNotResumableError)
			expect((err as RunNotResumableError).status).toBe(status)

			expect(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).toBe(metaBefore)
			expect(readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')).toBe(messagesBefore)
		},
	)

	it('resumes a run that crashed WITHOUT parking — a non-terminal run with no decision is still resumable', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// A crashed segment leaves the run non-terminal and holding no useful status. This
		// is what checkpoint-resume existed for BEFORE durable pause was built on top of it,
		// and restricting resume to "parked, with a live decision" would brick every run
		// that died mid-loop. It stays allowed, deliberately.
		const control = new RunDiskStore({ baseDir })
		await control.initRun(RUN_ID)
		await control.updateRunMeta((meta) => ({ ...meta, status: 'running' }))

		const run = await drive({
			cwd,
			provider: stopping('recovered'),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		})
		expect(run.status).toBe('completed')
	})
})

describe('fork starts a NEW run and leaves the source alone', () => {
	it('mints a new id, records provenance, and the source run’s record is byte-identical', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// Finish the source run, so it is exactly the thing a resume must refuse and a fork
		// must be able to work from.
		const source = await drive({
			cwd,
			provider: stopping('source finished'),
			tools: registryWith(noopTool(calls)),
			resumeFromCheckpoint: checkpointId,
		})
		expect(source.status).toBe('completed')

		const metaBefore = readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')
		const messagesBefore = readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')

		const fork = await prepareForkState({ baseDir, runId: RUN_ID, fromCheckpoint: checkpointId })
		expect(fork.runId).not.toBe(RUN_ID)
		expect(fork.sourceRunId).toBe(RUN_ID)

		const forked = await drainQuery({
			provider: stopping('fork finished'),
			tools: registryWith(noopTool(calls)),
			runConfig: RUN_CONFIG,
			agentId: 'agent_test',
			agentName: 'Test',
			workingDirectory: cwd,
			runId: fork.runId,
			messages: fork.messages,
			replayOf: fork.attribution,
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			projectId: PROJECT_ID,
			tenantId: TENANT_ID,
		})

		expect(forked.id).toBe(fork.runId)
		expect(forked.status).toBe('completed')

		// The fork's OWN record carries where it came from. The source's record cannot: a
		// fork does not touch its source, which is the entire distinction from a re-drive.
		const forkMeta = readJson(join(baseDir, fork.runId, 'run.json'))
		expect(forkMeta.id).toBe(fork.runId)
		expect(forkMeta.replayOf).toMatchObject({
			sourceRunId: RUN_ID,
			fromCheckpointId: checkpointId,
		})

		// And the source is untouched — byte-for-byte, `run.json` and `messages.json` both.
		expect(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).toBe(metaBefore)
		expect(readFileSync(join(baseDir, RUN_ID, 'messages.json'), 'utf-8')).toBe(messagesBefore)
	})

	it('refuses to fork INTO the source run — that is an overwrite wearing a fork’s clothes', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		await expect(
			prepareForkState({
				baseDir,
				runId: RUN_ID,
				fromCheckpoint: checkpointId,
				newRunId: RUN_ID,
			}),
		).rejects.toThrow(ForkTargetsSourceRunError)

		// And the same refusal at the other door: attribution that names the run it is
		// driving. Neither door can be walked around by way of the other.
		const fork = await prepareForkState({ baseDir, runId: RUN_ID, fromCheckpoint: checkpointId })
		await expect(
			drainQuery({
				provider: stopping(),
				tools: registryWith(noopTool(calls)),
				runConfig: RUN_CONFIG,
				agentId: 'agent_test',
				agentName: 'Test',
				workingDirectory: cwd,
				runId: RUN_ID,
				messages: fork.messages,
				replayOf: fork.attribution,
				sessionId: SESSION_ID,
				threadId: THREAD_ID,
				projectId: PROJECT_ID,
				tenantId: TENANT_ID,
			}),
		).rejects.toThrow(ForkTargetsSourceRunError)
	})
})

describe('the in-process fast path is untouched', () => {
	it('an answering handler never parks, and leaves no lease behind', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []

		const run = await drive({
			cwd,
			provider: toolThenStop(),
			tools: registryWith(noopTool(calls)),
			decision: { action: 'approve_tools' },
			events,
		})

		expect(run.status).toBe('completed')
		expect(calls).toEqual(['noop'])
		expect(events.map((e) => e.type)).not.toContain('run_paused')

		// The lease is taken and handed back, so a second run of the same id is not locked
		// out by a lease nobody released.
		const lease = await readRunLease({ baseDir: runsDir(cwd), runId: RUN_ID })
		expect(lease.status).toBe('free')
		expect(lease.token).toBe(1)
	})
})
