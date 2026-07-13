// ses_017 fix-batch — the defects a 34-agent review found in the run lease, each reproduced
// before it was fixed.
//
// L1 — A CANCELLED RUN'S TOOL STILL EXECUTED. The admission docstring claimed the lease
// closed the window between reading the run's status and acting on it. It does not, and it
// cannot: `cancelRun` is the CONTROL PLANE — it takes no lease and is unfenced by design,
// because a cancel that could not touch a run somebody is driving would be useless. So the
// status admission reads can be false before the next line runs, and a single check at
// admission is a sample, not a guard.
//
// L6 — REDEMPTION SPENT THE TOKEN AGAINST A STALE LEASE WITHOUT TAKING IT OVER. It read the
// lease, saw `stale`, and proceeded — which fences nobody. The stalled-but-alive holder kept
// the current fencing token and could still write the run out from under the answer.
//
// L7 — A SUPERSEDED SEGMENT ANNOUNCED THE RUN'S DEATH. Its `onLost` abort drove it through
// `handleError`, which emits a terminal `run_failed` to every listener and appends it to the
// deliberately-unfenced `transcript.jsonl` — for a run another segment was at that moment
// driving to completion.
//
// L9 — AN ABANDONED GENERATOR HELD THE RUN FOREVER. A consumer that drops the generator
// without a `break` or a `.return()` never runs its `finally`, so the heartbeat renewed the
// lease every 10s for the life of the process and the run was never resumable again.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { RunPersistence } from '../../../manager/run/persistence.js'
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
import type { ChatCompletionResponse, LLMProvider } from '../../../types/provider/index.js'
import type { Run, RunEvent } from '../../../types/run/index.js'
import { RunLeaseLostError } from '../../../types/run/lease.js'
import { getRootLogger } from '../../../utils/logger.js'
import { RunNotResumableError } from '../decision/errors.js'
import { cancelRun, readPendingDecision, readRunLease, resumeDecision } from '../decision/resume.js'
import { drainQuery, query } from '../index.js'

const RUN_ID = 'run_defects' as RunId
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

/** Holds the segment INSIDE its model call, lease in hand, until the test lets it go. */
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
			async chat(): Promise<ChatCompletionResponse> {
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

function noopTool(calls: string[]) {
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

function registryWith(calls: string[]): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register(noopTool(calls) as never)
	return tools
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-ses017-defects-'))
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
	events?: RunEvent[]
	lease?: { ttlMs?: number; heartbeatMs?: number; abandonAfterMs?: number }
}

function paramsFor(opts: DriveOpts) {
	return {
		provider: opts.provider,
		tools: opts.tools,
		runConfig: RUN_CONFIG,
		agentId: 'agent_test',
		agentName: 'Test',
		workingDirectory: opts.cwd,
		messages: [],
		runId: RUN_ID,
		sessionId: SESSION_ID,
		threadId: THREAD_ID,
		projectId: PROJECT_ID,
		tenantId: TENANT_ID,
		lease: opts.lease,
		resumeFromCheckpoint: opts.resumeFromCheckpoint,
		resumeHandler: async (_req: HITLDecisionRequest) =>
			opts.decision ?? ({ action: 'continue' } as const),
	}
}

async function drive(opts: DriveOpts): Promise<Run> {
	return drainQuery(paramsFor(opts), (e) => {
		opts.events?.push(e)
	})
}

/** Park a run at a tool review and redeem the token, so the batch is armed and unspent. */
async function parkAndApprove(cwd: string, calls: string[]) {
	const events: RunEvent[] = []
	await drive({
		cwd,
		provider: toolThenStop(),
		tools: registryWith(calls),
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

function transcript(baseDir: string): string[] {
	return readFileSync(join(baseDir, RUN_ID, 'transcript.jsonl'), 'utf-8')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line).type)
}

describe('L1 — a cancelled run does not run its tools', () => {
	it('the user cancels a parked run while a worker is resuming it: the approved batch does NOT run', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		// THE RACE, driven deterministically. The worker is admitted (it reads
		// `awaiting_input`, takes the lease, runs `init()`), and the cancel lands in the
		// window between that read and the dispatch of the batch. `run_resuming` is emitted
		// from inside that window, so pulling it puts us exactly there.
		const events: RunEvent[] = []
		const gen = query(
			paramsFor({
				cwd,
				provider: stopping(),
				tools: registryWith(calls),
				resumeFromCheckpoint: checkpointId,
			}),
		)

		let cancelled = false
		let step = await gen.next()
		while (!step.done) {
			events.push(step.value)
			if (step.value.type === 'run_resuming' && !cancelled) {
				cancelled = true
				// The user changes their mind. `cancelRun` holds no lease and is unfenced — that
				// is deliberate — so it lands cleanly, closes nothing that is already `resolved`,
				// writes `run.json = cancelled`, and returns "the run is dead" to the user.
				const outcome = await cancelRun({ baseDir, runId: RUN_ID })
				expect(outcome.status).toBe('cancelled')
			}
			step = await gen.next()
		}
		expect(cancelled).toBe(true)

		// The tool the user cancelled did NOT run. This is the whole finding: the worker
		// carried on, `init()` stamped its in-memory `idle` over the cancellation (the fence
		// permits it — this segment DOES hold the lease), the deploy tool ran, and the run
		// finished `completed` while the user had been told it was dead.
		expect(calls).toEqual([])
		expect(step.value.status).toBe('cancelled')

		// And the record agrees with what the user was told, rather than contradicting it.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).toBe('cancelled')
	})

	// CHECK POINT 1, on its own — and it is NOT the approved-batch path, which the check below
	// covers. Its unique job is the re-park: a decision that is still UNANSWERED.
	//
	// The checkpoint is restored during admission, so the decision the dispatcher acts on is
	// an IN-MEMORY snapshot. A cancel landing after that read leaves the segment holding a
	// decision that says `pending` while the disk says `cancelled` — and `reparkPending` then
	// calls `markSuspended`, which writes `awaiting_input` straight back over the
	// cancellation. The fence permits it: this segment does hold the lease. The result is the
	// worst record of all — a run that reads parked, whose decision is cancelled, so it can
	// never be answered and never be finished.
	it('a cancel landing after the checkpoint was read does not let the run RE-PARK itself', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []

		// Parked, and NOT approved — the decision is still `pending`.
		await drive({
			cwd,
			provider: toolThenStop(),
			tools: registryWith(calls),
			decision: { action: 'pause', reason: 'stepping away' },
			events,
		})
		const checkpointId = (
			events.find((e) => e.type === 'run_paused') as { checkpointId: CheckpointId }
		).checkpointId
		const baseDir = runsDir(cwd)

		const gen = query(
			paramsFor({
				cwd,
				provider: stopping(),
				tools: registryWith(calls),
				resumeFromCheckpoint: checkpointId,
				// Nobody is there to answer, so the dispatcher takes the re-park branch.
				decision: { action: 'pause', reason: 'still away' },
			}),
		)

		let step = await gen.next()
		let cancelled = false
		while (!step.done) {
			if (step.value.type === 'run_resuming' && !cancelled) {
				cancelled = true
				await cancelRun({ baseDir, runId: RUN_ID })
			}
			step = await gen.next()
		}
		expect(cancelled).toBe(true)

		// The run stays cancelled. It does not get to declare itself parked again on a decision
		// the cancel has already closed.
		expect(step.value.status).toBe('cancelled')
		expect(JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).status).toBe(
			'cancelled',
		)
	})

	// CHECK POINT 2, on its own. The cancel lands AFTER the dispatcher has looked — inside the
	// window between that look and the batch going out, which is real: the outcome is applied,
	// the gate is re-run, and `tool_review_completed` is emitted and yielded to the consumer
	// in between. Only the check immediately before the dispatch can catch this one.
	it('the cancel that lands between the dispatcher’s check and the batch is still caught', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { checkpointId, baseDir } = await parkAndApprove(cwd, calls)

		const gen = query(
			paramsFor({
				cwd,
				provider: stopping(),
				tools: registryWith(calls),
				resumeFromCheckpoint: checkpointId,
			}),
		)

		let cancelled = false
		let step = await gen.next()
		while (!step.done) {
			if (step.value.type === 'tool_review_completed' && !cancelled) {
				cancelled = true
				await cancelRun({ baseDir, runId: RUN_ID })
			}
			step = await gen.next()
		}

		expect(cancelled).toBe(true)
		expect(calls).toEqual([])
		expect(step.value.status).toBe('cancelled')

		// And nothing was SPENT on the way out: the execution claim is permanent, so burning it
		// here would make the batch undispatchable even if this cancel later turns out to have
		// raced a legitimate resume. The check sits before the claim, deliberately.
		const claims = join(baseDir, RUN_ID, 'decisions', `${checkpointId}.execution.json`)
		expect(() => readFileSync(claims, 'utf-8')).toThrow()
	})

	// The resume dispatcher is not the only door into the executor: a run cancelled while it
	// is RUNNING has the same problem one layer along, and worse — before this, a durable
	// cancel reached a live loop through no channel at all.
	it('a run cancelled mid-loop stops before its next tool batch, instead of running to completion', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const baseDir = runsDir(cwd)

		const events: RunEvent[] = []
		const gen = query(
			paramsFor({
				cwd,
				provider: toolThenStop(),
				tools: registryWith(calls),
				decision: { action: 'approve_tools' },
			}),
		)

		let step = await gen.next()
		while (!step.done) {
			events.push(step.value)
			// The model has asked for a tool; the batch has not been dispatched yet. A cancel
			// arriving now must be seen by the loop — and there is no signal to raise, no lease
			// to revoke and no in-band channel to reach it: the ONLY way it can find out is by
			// re-reading its own record.
			if (
				step.value.type === 'llm_response' &&
				(step.value as { hasToolCalls: boolean }).hasToolCalls
			) {
				await cancelRun({ baseDir, runId: RUN_ID })
			}
			step = await gen.next()
		}

		expect(calls).toEqual([])
		expect(step.value.status).toBe('cancelled')
		expect(JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).status).toBe(
			'cancelled',
		)
	})
})

// The last check point, and the one nothing outside the process can reach: the window
// between admission READING the run's status and `init()` WRITING the first record. It is
// microseconds wide and it is exactly where an unfenced cancel lands. Driven directly,
// because that is the only way in.
describe('L1 — init() does not resurrect a run that was cancelled under it', () => {
	it('refuses to stamp a fresh `idle` over a cancelled record, and writes nothing', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const { baseDir } = await parkAndApprove(cwd, calls)

		const control = new RunDiskStore({ baseDir })
		await control.initRun(RUN_ID)
		await control.updateRunMeta((meta) => ({
			...meta,
			status: 'cancelled' as const,
			endedAt: Date.now(),
		}))
		const before = readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')

		// A segment that was admitted a moment before the cancel landed. `init()` reads the
		// persisted meta, finds `cancelled` — which is not `awaiting_input`, so the
		// preservation branch does not fire — and used to fall straight through to
		// `writeRunMeta`, stamping this segment's in-memory `idle` over the cancellation, with
		// zeroed usage and a zeroed iteration count. The fence permits it: this segment DOES
		// hold the lease. The run was resurrected, and everything downstream of it ran.
		const runMgr = new RunPersistence({
			runId: RUN_ID,
			agentId: 'agent_test',
			agentName: 'Test',
			runConfig: RUN_CONFIG,
			providerId: 'fake',
			outputDir: baseDir,
			log: getRootLogger().child({ component: 'test' }),
			sessionId: SESSION_ID,
			threadId: THREAD_ID,
			tenantId: TENANT_ID,
			projectId: PROJECT_ID,
		})

		await expect(runMgr.init()).rejects.toThrow(RunNotResumableError)
		expect(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8')).toBe(before)
	})
})

describe('L6 — redeeming a decision fences the stalled holder it takes the run from', () => {
	it('a stalled segment cannot write the run out from under the answer it was just given', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const events: RunEvent[] = []
		await drive({
			cwd,
			provider: toolThenStop(),
			tools: registryWith(calls),
			decision: { action: 'pause', reason: 'stepping away' },
			events,
		})
		const checkpointId = (
			events.find((e) => e.type === 'run_paused') as { checkpointId: CheckpointId }
		).checkpointId
		const baseDir = runsDir(cwd)

		// A segment took the run and stalled — a 40-second GC pause, a suspended container. It
		// is not dead; it is going to wake up. `init()` preserves a persisted `awaiting_input`
		// across a resume, so `run.json` still reads parked while it holds the lease.
		const stalled = new RunDiskStore({ baseDir })
		await stalled.initRun(RUN_ID)
		await stalled.acquireLease(RUN_ID, { ttlMs: 40, holderId: 'stalled-segment' })
		await sleep(60)
		expect((await readRunLease({ baseDir, runId: RUN_ID })).status).toBe('stale')

		// The human answers. Redemption proceeds on a STALE lease — correctly, that is the
		// recovery the TTL exists to permit — and permanently spends the single-use token.
		const decision = await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId })
		if (!decision) throw new Error('no pending decision')
		await resumeDecision({
			baseDir,
			runId: RUN_ID,
			checkpointId,
			resumeToken: decision.resumeToken,
			decision: { action: 'approve_tools' },
		})

		// …and NOW the stalled segment wakes up. Before this fix it was never fenced: the
		// redemption only READ the lease, so the stalled holder still carried the current
		// fencing token, passed its own fence, and could re-park the run on a new decision
		// (orphaning the one just answered) or terminalize it — at which point the resume the
		// caller was just handed is refused and the approved batch never runs, with the token
		// already gone.
		await expect(
			stalled.updateRunMeta((meta) => ({ ...meta, status: 'failed' as const })),
		).rejects.toThrow(RunLeaseLostError)

		// The run is still exactly what the redemption left: parked, answered, resumable.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).toBe('awaiting_input')
		expect((await readPendingDecision({ baseDir, runId: RUN_ID, checkpointId }))?.state).toBe(
			'resolved',
		)

		// And the resume the human's answer bought actually works.
		const resumed = await drive({
			cwd,
			provider: stopping('resumed'),
			tools: registryWith(calls),
			resumeFromCheckpoint: checkpointId,
		})
		expect(resumed.status).toBe('completed')
		expect(calls).toEqual(['noop'])
	})
})

describe('L7 — a segment that lost its lease exits quietly', () => {
	it('does not emit run_failed, does not append it to the transcript, and does not touch the record', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const baseDir = runsDir(cwd)

		// A short TTL and a fast heartbeat, so the takeover is noticed within the test.
		const barrier = barrierProvider('superseded segment finished')
		const events: RunEvent[] = []
		const superseded = drainQuery(
			paramsFor({
				cwd,
				provider: barrier.provider,
				tools: registryWith(calls),
				lease: { ttlMs: 60, heartbeatMs: 20 },
			}),
			(e) => {
				events.push(e)
			},
		).catch((e) => e)

		// It is inside its model call, holding the lease, about to come back and write.
		await barrier.entered

		// The run is taken over at a higher fencing token.
		//
		// Written straight to disk, because the takeover is another PROCESS and this test is
		// one: the segment above is alive and its heartbeat is renewing, so nothing in-process
		// can make its lease go stale — a real stall blocks the stalled process's event loop,
		// not ours. The file planted here is byte-for-byte what `acquireLease` writes when it
		// takes a stale run over, which is the only thing the segment under test can see.
		writeFileSync(
			join(baseDir, RUN_ID, 'leases', '000002.json'),
			JSON.stringify({
				runId: RUN_ID,
				token: 2,
				holderId: 'taker',
				acquiredAt: Date.now(),
				renewedAt: Date.now(),
				ttlMs: 60_000,
			}),
		)

		// Its heartbeat notices — that is what the heartbeat is FOR. Let it come back from the
		// provider and try to finish the run it no longer owns.
		await sleep(60)
		barrier.release()
		const outcome = await superseded

		// It stops — and it says so to its CALLER, with a typed error…
		expect(outcome).toBeInstanceOf(RunLeaseLostError)

		// …but it says NOTHING about the run. `run_failed` on the event stream is read by the
		// API's SSE feed, the event bridges and the CLI's run view as "this run is dead", and
		// `transcript.jsonl` is append-only and deliberately unfenced, so nothing else would
		// have stopped it landing there for a run that another segment is driving perfectly
		// well.
		expect(events.map((e) => e.type)).not.toContain('run_failed')
		expect(transcript(baseDir)).not.toContain('run_failed')

		// And the record is the taker's to write. The superseded segment did not persist —
		// not even the attempt, which the fence would have refused with a second error thrown
		// from inside `finalize()`, after the terminal events had already gone out.
		const meta = JSON.parse(readFileSync(join(baseDir, RUN_ID, 'run.json'), 'utf-8'))
		expect(meta.status).not.toBe('failed')
	})
})

describe('L9 — a run nobody is driving does not stay held', () => {
	it('an abandoned generator gives the run back instead of renewing its lease forever', async () => {
		const cwd = tmp()
		const calls: string[] = []
		const baseDir = runsDir(cwd)

		// A consumer that pulls one event and drops the generator. Not a `break` (which calls
		// `.return()` and runs the `finally`), not a `.return()` — a dropped reference, which
		// is the one shape that runs no cleanup at all. Node does not run a generator's
		// `finally` on collection, so nothing else will ever notice.
		let gen: AsyncGenerator<RunEvent, Run> | undefined = query(
			paramsFor({
				cwd,
				provider: stopping(),
				tools: registryWith(calls),
				lease: { ttlMs: 200, heartbeatMs: 20, abandonAfterMs: 60 },
			}),
		)
		await gen.next()
		gen = undefined

		// The heartbeat is the only thing still running in there, so the heartbeat is what has
		// to notice. Before this it renewed every 20ms for the life of the process: the run
		// read `held` to every operator and every resume, and it was never resumable again.
		await sleep(300)

		const lease = await readRunLease({ baseDir, runId: RUN_ID })
		expect(lease.status).toBe('free')

		// And it is genuinely resumable — not merely reported free.
		const rerun = await drive({
			cwd,
			provider: stopping('picked back up'),
			tools: registryWith(calls),
		})
		expect(rerun.status).toBe('completed')
	})
})
