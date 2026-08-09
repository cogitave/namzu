import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { InMemoryCheckpointStore as RealInMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { CheckpointRunScope, CheckpointStore } from '../../../types/run/checkpoint-store.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { resumeRun } from '../resume-run.js'
import type { RunStateScope } from '../run-state.js'

/**
 * The pieces of a cross-process resume all existed and nothing joined them.
 * `CheckpointManager` wrote the history, budgets, working state and any
 * park; `loadRunState` read them back; `query` accepted `runId` +
 * `resumeFromCheckpoint` and restored all of it. But `resumeFromCheckpoint`
 * had no caller anywhere outside `packages/sdk/src`, so the whole path
 * shipped untravelled — every host was expected to write the same wiring
 * and none did.
 *
 * These cover the join, and especially its two refusals: a resume must not
 * quietly become a fresh run under a recycled id, and it must not step past
 * a park without the answer that park is waiting for.
 */

const SCOPE: RunStateScope = {
	tenantId: 'tnt_resume' as TenantId,
	projectId: 'prj_resume' as ProjectId,
	sessionId: 'ses_resume' as SessionId,
	runId: 'run_resume' as RunId,
	threadId: 'thd_resume' as ThreadId,
}

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

const ZERO_COST = {
	inputCostPer1M: 0,
	outputCostPer1M: 0,
	totalCost: 0,
	cacheDiscount: 0,
}

class InMemoryCheckpointStore implements CheckpointStore {
	readonly rows = new Map<string, IterationCheckpoint>()

	private key(scope: CheckpointRunScope, id: CheckpointId): string {
		return [scope.tenantId, scope.projectId, scope.sessionId, scope.runId, id].join('/')
	}

	async writeCheckpoint(scope: CheckpointRunScope, checkpoint: IterationCheckpoint): Promise<void> {
		this.rows.set(this.key(scope, checkpoint.id), checkpoint)
	}

	async readCheckpoint(
		scope: CheckpointRunScope,
		id: CheckpointId,
	): Promise<IterationCheckpoint | null> {
		return this.rows.get(this.key(scope, id)) ?? null
	}

	async listCheckpoints(scope: CheckpointRunScope): Promise<IterationCheckpoint[]> {
		const prefix = `${[scope.tenantId, scope.projectId, scope.sessionId, scope.runId].join('/')}/`
		return [...this.rows.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([, cp]) => cp)
			.sort((a, b) => a.createdAt - b.createdAt)
	}

	async deleteCheckpoint(scope: CheckpointRunScope, id: CheckpointId): Promise<void> {
		this.rows.delete(this.key(scope, id))
	}
}

function checkpoint(overrides: Partial<IterationCheckpoint> = {}): IterationCheckpoint {
	return {
		id: 'ckpt_1' as CheckpointId,
		runId: SCOPE.runId,
		iteration: 2,
		messages: [createUserMessage('the work so far')],
		tokenUsage: { ...ZERO_USAGE, promptTokens: 120, totalTokens: 120 },
		costInfo: { ...ZERO_COST, totalCost: 0.4 },
		guardState: { iterationCount: 2, elapsedMs: 9_000 },
		createdAt: Date.now(),
		...overrides,
	} as IterationCheckpoint
}

let workdirs: string[] = []

afterEach(async () => {
	await removeTempDirs(workdirs)
	workdirs = []
})

async function mkWorkdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-resume-run-'))
	workdirs.push(dir)
	return dir
}

/**
 * A provider and registry that make the run actually ITERATE.
 *
 * A text-only turn finishes before the iteration checkpoint phase runs, so
 * nothing is written and a fence has nothing to be presented on — measured:
 * zero `writeCheckpoint` calls for the whole resume. A claim test built on
 * that shape cannot fail, whatever the wiring does. One tool call and a
 * closing turn is the shortest run that checkpoints.
 */
function toolCallingProvider(): MockLLMProvider {
	return new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'echo', args: { text: 'hi' } }] }, { text: 'continued' }],
	})
}

function registryWithEcho(): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'echo',
		description: 'echo the text back',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'hi' }),
	})
	return tools
}

async function baseParams(store: CheckpointStore) {
	return {
		scope: SCOPE,
		checkpointStore: store,
		provider: new MockLLMProvider({ turns: [{ text: 'continued' }] }),
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 30_000,
			tokenBudget: 100_000,
			maxIterations: 2,
			maxResponseTokens: 256,
		},
		agentId: 'agent_resume',
		agentName: 'Resume Agent',
		workingDirectory: await mkWorkdir(),
		sessionId: SCOPE.sessionId,
		threadId: SCOPE.threadId,
		projectId: SCOPE.projectId,
		tenantId: SCOPE.tenantId,
		// Required by the contract, and rightly so: a resume that lands on a
		// park has to have somewhere to ask.
		resumeHandler: async () => ({ action: 'continue' as const }),
	}
}

describe('a run is picked back up from its store', () => {
	it('continues the same run id rather than starting a new one', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint())

		const outcome = await resumeRun(await baseParams(store))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		// The whole point: a resume is the same run in a different process,
		// so its id, budgets and trace all have to carry across.
		expect(outcome.run.id).toBe(SCOPE.runId)
		expect(outcome.state.checkpointId).toBe('ckpt_1')
	})

	it('carries the spent budget forward instead of granting a fresh one', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint())

		const outcome = await resumeRun(await baseParams(store))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		// A run recalled at 120 tokens must not come back at zero — the
		// budget belongs to the run, not to the process hosting it.
		expect(outcome.run.tokenUsage.totalTokens).toBeGreaterThanOrEqual(120)
	})

	it('picks the newest checkpoint when the caller names none', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint({ id: 'ckpt_old' as CheckpointId, createdAt: 1 }))
		await store.writeCheckpoint(
			SCOPE,
			checkpoint({ id: 'ckpt_new' as CheckpointId, createdAt: 2_000 }),
		)

		const outcome = await resumeRun(await baseParams(store))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.state.checkpointId).toBe('ckpt_new')
	})

	it('honours an explicitly named checkpoint', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint({ id: 'ckpt_old' as CheckpointId, createdAt: 1 }))
		await store.writeCheckpoint(
			SCOPE,
			checkpoint({ id: 'ckpt_new' as CheckpointId, createdAt: 2_000 }),
		)

		const outcome = await resumeRun({
			...(await baseParams(store)),
			checkpointId: 'ckpt_old' as CheckpointId,
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.state.checkpointId).toBe('ckpt_old')
	})
})

describe('it refuses rather than guessing', () => {
	it('reports no checkpoint instead of silently starting fresh', async () => {
		const outcome = await resumeRun(await baseParams(new InMemoryCheckpointStore()))

		// Starting a new run here would be the worst outcome: a different
		// run wearing a recycled id, with the original's budget reset.
		expect(outcome).toEqual({ resumed: false, reason: 'no-checkpoint' })
	})

	it('hands back the outstanding question instead of resuming past it', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(
			SCOPE,
			checkpoint({
				pending: {
					request: {
						type: 'tool_review',
						runId: SCOPE.runId,
						checkpointId: 'ckpt_1' as CheckpointId,
						toolCalls: [{ id: 'call_1', name: 'write', input: {} }],
					},
					parkedAt: Date.now(),
					deadlineAt: Date.now() + 60_000,
				},
			} as unknown as Partial<IterationCheckpoint>),
		)

		const outcome = await resumeRun(await baseParams(store))

		expect(outcome.resumed).toBe(false)
		if (outcome.resumed || outcome.reason !== 'awaiting-decision') {
			throw new Error(`expected awaiting-decision, got ${JSON.stringify(outcome)}`)
		}
		// The host needs the request itself to put in front of a person.
		expect(outcome.pending.request.type).toBe('tool_review')
		expect(outcome.state.runId).toBe(SCOPE.runId)
	})

	it('treats an already-answered park as an ordinary resume', async () => {
		const store = new InMemoryCheckpointStore()
		await store.writeCheckpoint(
			SCOPE,
			checkpoint({
				pending: {
					request: {
						type: 'tool_review',
						runId: SCOPE.runId,
						checkpointId: 'ckpt_1' as CheckpointId,
						toolCalls: [{ id: 'call_1', name: 'write', input: {} }],
					},
					parkedAt: Date.now(),
					deadlineAt: Date.now() + 60_000,
					resolvedAt: Date.now(),
				},
			} as unknown as Partial<IterationCheckpoint>),
		)

		const outcome = await resumeRun(await baseParams(store))

		// `resolvedAt` is what makes a park answered. Blocking on one that
		// already has its answer would strand the run permanently.
		expect(outcome.resumed).toBe(true)
	})
})

describe('a resume carries the claim it was given', () => {
	/**
	 * The fix for "the fence never reached the runtime" was itself untested,
	 * and it is the most convincing kind of decorative test.
	 *
	 * The only claim-fence test in the package built a `CheckpointManager`
	 * directly and handed it a fence. That was never the defect — a manager
	 * ignoring a fence it is given is code that never had a bug. **The defect
	 * was that nothing gave it one.** The wiring is two lines, `query()` and
	 * `resume-run.ts`, and deleting either left the whole suite green: exactly
	 * the state the fix's own commit message describes, everything built and
	 * tested with no path between a run and its store carrying the number.
	 *
	 * So this drives the real entry point with the real store. It crosses both
	 * hops — `resumeRun` forwards the fence to `query`, `query` presents it to
	 * the manager, the manager presents it on the write — and it asserts the
	 * refusal, which only the store can produce. Remove either line and the run
	 * writes unfenced and this test fails.
	 */
	async function iteratingParams(store: CheckpointStore) {
		return {
			...(await baseParams(store)),
			provider: toolCallingProvider(),
			tools: registryWithEcho(),
			runConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
		}
	}

	it('is refused when another worker has taken the run over', async () => {
		const store = new RealInMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint())

		// w1 takes the run and stalls. w2 reclaims it once the lease lapses.
		const stale = await store.claimRun(SCOPE, { holder: 'w1', ttlMs: 1, now: 1_000 })
		await store.claimRun(SCOPE, { holder: 'w2', ttlMs: 60_000, now: 5_000 })

		// w1 wakes up and resumes, still believing it holds the run. It cannot
		// know otherwise — a pause, a suspended container and a partition all
		// look from the inside like time not passing. The write is the only
		// place it can be told, and it is two hops away from here.
		const outcome = await resumeRun({
			...(await iteratingParams(store)),
			claimFence: stale?.fence,
		})

		// `resumeRun` RESOLVES. The refusal arrives as a failed run rather than
		// a rejected promise, which is worth stating because a host wrapping
		// this call in `try`/`catch` would see nothing: the fence is reported
		// on the run, and `status` is what a queue worker has to read.
		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.run.status).toBe('failed')
		expect(outcome.run.stopReason).toBe('error')
		expect(outcome.run.lastError).toMatch(/no longer holds it/)
	})

	it('lets the current holder resume and finish', async () => {
		// The preservation half, and the one that keeps the test above from
		// passing on any failure at all. A refusal that fires for the rightful
		// holder too is not a fence, it is an outage.
		const store = new RealInMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint())
		const claim = await store.claimRun(SCOPE, { holder: 'w1', ttlMs: 60_000, now: 1_000 })

		const outcome = await resumeRun({
			...(await iteratingParams(store)),
			claimFence: claim?.fence,
		})

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.run.status).not.toBe('failed')
	})

	it('resumes unfenced when the host holds no claim', async () => {
		// Every run did this before claims existed, and a host that has not
		// adopted them must keep working — including on a run somebody else
		// holds, because an unfenced write is still accepted.
		const store = new RealInMemoryCheckpointStore()
		await store.writeCheckpoint(SCOPE, checkpoint())
		await store.claimRun(SCOPE, { holder: 'somebody-else', ttlMs: 60_000, now: 1_000 })

		const outcome = await resumeRun(await iteratingParams(store))

		expect(outcome.resumed).toBe(true)
		if (!outcome.resumed) return
		expect(outcome.run.status).not.toBe('failed')
	})
})
