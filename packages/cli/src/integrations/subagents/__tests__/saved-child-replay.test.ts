import { mkdir, mkdtemp } from 'node:fs/promises'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type Run, RunDiskStore, type RunEvent } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { activeSubagentCohorts } from '../../../tui/AgentExplorer.js'
import {
	DEFAULT_AGENT_WORKFLOW,
	PARTIAL_EVIDENCE_NOTICE,
	type SubagentActivity,
	SubagentActivityMonitor,
} from '../activity.js'
import { listSavedChildren, replaySavedChildren } from '../replay.js'

/**
 * One projection, two sources.
 *
 * The cockpit renders a live child and a finished one through the same
 * `SubagentActivity`, and the only way that stays true is for both to come
 * out of the same projection. A replay that grew its own would not fail
 * loudly — it would drift, one field at a time, until the past rendered
 * differently from the present and the report came back months later as "the
 * saved view looks wrong". The equality test below is the guard for that, and
 * it is the reason this file exists.
 */

const PARENT_SESSION = 'd4b1c1a8-8f2e-4bd6-9a19-0c2b8a1c5f11'
const CHILD_SESSION = 'ee3f2b70-5c41-4a16-9a2f-71bd0a3c9e22'
const PARENT_RUN = '5f8a9f2b-9f0d-4a1e-9e1d-0f0a2b3c4d5e'
const CHILD_RUN = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const TASK = 'c9d8e7f6-a5b4-4c3d-8e2f-1a0b9c8d7e6f'
const NOW = 1_700_000_000_000

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
	vi.restoreAllMocks()
})

beforeEach(() => {
	// Both paths stamp their own clock — `begin()` for `startedAt`, the
	// `agent_completed` case for `completedAt` — so the clock has to stand
	// still for "equal" to mean anything about the projection.
	vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

async function sessionsRoot(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-replay-'))
	dirs.push(dir)
	const root = join(dir, 'sessions')
	// The conversation's own run directory. This is what survives a restart
	// and names the parent runs whose children are worth looking for.
	await mkdir(join(root, PARENT_SESSION, 'runs', PARENT_RUN), { recursive: true })
	return root
}

/** The events a child of this shape leaves behind, in order, numbered. */
function childEvents(): readonly RunEvent[] {
	return [
		{
			type: 'agent_pending',
			runId: PARENT_RUN,
			taskId: TASK,
			parentAgentId: 'namzu',
			childAgentId: 'reviewer',
			depth: 1,
			workflow: 'Ship it',
			phase: 'Review',
			phaseOrder: 2,
			phaseDetail: 'read the whole diff',
			seq: 1,
		},
		{ type: 'run_started', runId: CHILD_RUN, systemPrompt: 'review', seq: 2 },
		{
			type: 'tool_executing',
			runId: CHILD_RUN,
			toolUseId: 'tool-1',
			toolName: 'Read',
			input: { path: 'src/a.ts' },
			seq: 3,
		},
		{
			type: 'tool_completed',
			runId: CHILD_RUN,
			toolUseId: 'tool-1',
			toolName: 'Read',
			result: 'two hundred lines',
			isError: false,
			seq: 4,
		},
		{
			type: 'token_usage_updated',
			runId: CHILD_RUN,
			usage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
			cost: { totalCost: 0 },
			seq: 5,
		},
		{
			type: 'agent_completed',
			runId: PARENT_RUN,
			taskId: TASK,
			result: { status: 'completed', stopReason: 'end_turn' },
			seq: 6,
		},
	] as unknown as readonly RunEvent[]
}

/**
 * The `run.json` beside {@link childEvents}, deliberately AGREEING with what
 * those events project.
 *
 * That agreement is what makes the equality test below mean something: the
 * run.json overlay `replay()` applies afterwards is a no-op here, so what is
 * compared against the live path is the projection and nothing else. The
 * overlay itself is pinned separately, by the production-shape case, whose
 * run.json disagrees with its events on every field the overlay writes.
 */
function childRun(): Run {
	return {
		id: CHILD_RUN,
		status: 'completed',
		metadata: {
			agentId: 'reviewer',
			agentName: 'reviewer',
			config: { model: 'a-model', tokenBudget: 0 },
			provider: 'mock',
		},
		messages: [],
		tokenUsage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
		costInfo: { totalCost: 0 },
		currentIteration: 1,
		startedAt: NOW,
		endedAt: NOW,
		parentRunId: PARENT_RUN,
		depth: 1,
	} as unknown as Run
}

/**
 * The events a child of this shape ACTUALLY leaves behind.
 *
 * No `agent_pending`, no `agent_completed`: delegation lifecycle events are
 * reported on the PARENT's stream and enter no run's durable log, which the
 * `agent_pending` doc comment states and a real child's `transcript.jsonl`
 * confirms. This is therefore the only event shape a replay meets in
 * production, and the one that proves the run.json overlay is load-bearing —
 * `run_completed` has no case in the projection, so without the overlay this
 * child would come back `working` for ever.
 */
function productionChildEvents(): readonly RunEvent[] {
	return [
		{ type: 'run_started', runId: CHILD_RUN, systemPrompt: 'review', seq: 1 },
		{ type: 'iteration_started', runId: CHILD_RUN, iteration: 1, seq: 2 },
		{
			type: 'tool_executing',
			runId: CHILD_RUN,
			toolUseId: 'tool-1',
			toolName: 'Read',
			input: { path: 'src/a.ts' },
			seq: 3,
		},
		{
			type: 'tool_completed',
			runId: CHILD_RUN,
			toolUseId: 'tool-1',
			toolName: 'Read',
			result: 'two hundred lines',
			isError: false,
			seq: 4,
		},
		{
			type: 'token_usage_updated',
			runId: CHILD_RUN,
			usage: { promptTokens: 400, completionTokens: 200, totalTokens: 600 },
			cost: { totalCost: 0 },
			seq: 5,
		},
		{ type: 'iteration_completed', runId: CHILD_RUN, iteration: 1, hasToolCalls: true, seq: 6 },
		{ type: 'run_completed', runId: CHILD_RUN, result: 'done', stopReason: 'end_turn', seq: 7 },
	] as unknown as readonly RunEvent[]
}

/**
 * The `run.json` beside {@link productionChildEvents}, DISAGREEING with those
 * events on every field the overlay writes.
 *
 * Distinct values on purpose. Matching ones would let all four assignments be
 * deleted with every test still green, which is how a load-bearing block ends
 * up untested.
 */
function productionChildRun(): Run {
	return {
		...childRun(),
		tokenUsage: { promptTokens: 600, completionTokens: 300, totalTokens: 900 },
		startedAt: NOW - 5_000,
		endedAt: NOW - 1_000,
	} as unknown as Run
}

/** Writes one child exactly the way the delegated runtime writes one. */
async function persistChild(
	root: string,
	events: readonly RunEvent[],
	run: Run = childRun(),
): Promise<string> {
	const base = join(root, CHILD_SESSION, 'runs')
	const store = new RunDiskStore({ baseDir: base, logger: LOG })
	const dir = await store.initRun(CHILD_RUN, PARENT_RUN)
	for (const event of events) await store.appendEvent(event)
	await store.writeRunMeta(run)
	return dir
}

/** The same events through the live path, seeded the way replay seeds itself. */
function liveProjection(events: readonly RunEvent[]): SubagentActivity {
	const monitor = new SubagentActivityMonitor()
	const tracker = monitor.begin({
		agentId: 'reviewer',
		model: 'a-model',
		description: 'reviewer',
		prompt: '',
		batchId: `saved:${PARENT_RUN}`,
		workflowId: PARENT_RUN,
	})
	for (const event of events) tracker.onEvent(event)
	const [activity] = monitor.getSnapshot()
	if (!activity) throw new Error('the live monitor projected nothing')
	return activity
}

/**
 * One activity wearing another's ALLOCATED ids — the screen identity and the
 * phase identity a monitor mints for itself, plus the row ids that carry the
 * first as a prefix.
 *
 * Both are namespaced apart on the replay path on purpose, because every
 * surface looks a child up by `viewId` and groups phases by `phaseId` alone,
 * so one string naming two different things would merge rows that are not the
 * same work. Neither is a projected fact, which is why they are set aside
 * here and everything else is compared verbatim.
 */
function asAllocatedIds(
	activity: SubagentActivity,
	ids: { readonly viewId: string; readonly phaseId: string },
): SubagentActivity {
	return {
		...activity,
		viewId: ids.viewId,
		phaseId: ids.phaseId,
		transcript: activity.transcript.map((row) => ({
			...row,
			id: row.id.replace(activity.viewId, ids.viewId),
		})),
	}
}

describe('a finished delegated child, reopened from its saved evidence', () => {
	it('projects to exactly what the live path produced from the same events', async () => {
		const root = await sessionsRoot()
		const events = childEvents()
		await persistChild(root, events)

		const found = await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION })
		expect(found.map((child) => child.id)).toEqual([CHILD_RUN])

		const [replayed] = await replaySavedChildren(found)
		if (!replayed) throw new Error('the replay projected nothing')

		// Three fields may differ, and only these three. `replayed` is what
		// the saved view adds; `viewId` and `phaseId` are identities the
		// monitor allocates for itself, namespaced away from the live path's
		// so one string can never name two different things on screen.
		// Everything else is the projection's answer and must match exactly.
		const { replayed: marker, ...projected } = replayed
		expect(marker).toBe(true)
		expect(replayed.viewId).toBe(`saved-${CHILD_RUN}`)
		expect(replayed.phaseId.startsWith('saved-phase-')).toBe(true)
		const live = liveProjection(events)
		expect(
			asAllocatedIds(projected as SubagentActivity, {
				viewId: live.viewId,
				phaseId: live.phaseId,
			}),
		).toEqual(live)

		// Named explicitly as well, so a regression reports which field moved
		// rather than only that the objects stopped matching.
		expect(replayed.status).toBe('completed')
		expect(replayed.model).toBe('a-model')
		expect(replayed.tokens).toBe(600)
		expect(replayed.toolCalls).toBe(1)
		expect(replayed.workflow).toBe('Ship it')
		expect(replayed.phase).toBe('Review')
		expect(replayed.phaseDetail).toBe('read the whole diff')
		expect(replayed.transcript.map((row) => row.text)).toEqual(['Read(src/a.ts)'])
	})

	it('takes status, timings and totals from run.json for the shape a real child leaves', async () => {
		const root = await sessionsRoot()
		await persistChild(root, productionChildEvents(), productionChildRun())

		const [replayed] = await replaySavedChildren(
			await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION }),
		)
		if (!replayed) throw new Error('the replay projected nothing')

		// Each of these four is a fact only `run.json` holds, and each differs
		// from what this child's own events say, so deleting the overlay fails
		// here rather than passing quietly.
		expect(replayed.status).toBe('completed') // the events end on `working`
		expect(replayed.tokens).toBe(900) // `token_usage_updated` said 600
		expect(replayed.startedAt).toBe(NOW - 5_000) // `begin()` stamps NOW
		expect(replayed.completedAt).toBe(NOW - 1_000) // nothing stamps one at all
		expect(replayed.latestActivity).toBe('Completed')

		// What the transcript does carry is still there and still projected the
		// same way — the overlay adds facts, it does not replace the rows.
		expect(replayed.transcript.map((row) => row.text)).toEqual(['Read(src/a.ts)'])
		expect(replayed.toolCalls).toBe(1)
		expect(replayed.model).toBe('a-model')

		// And the labels are honestly absent: no `agent_pending` reached the
		// log, so this child groups by its parent run under the default
		// workflow rather than under a phase nothing recorded.
		expect(replayed.phaseDetail).toBeUndefined()
		expect(replayed.phaseOrder).toBeUndefined()
		expect(replayed.workflow).toBe(DEFAULT_AGENT_WORKFLOW)
		expect(replayed.workflowId).toBe(PARENT_RUN)
		expect(replayed.replayed).toBe(true)
	})

	it('is marked replayed and offers no continuation', async () => {
		const root = await sessionsRoot()
		await persistChild(root, childEvents())
		const [replayed] = await replaySavedChildren(
			await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION }),
		)
		if (!replayed) throw new Error('the replay projected nothing')

		expect(replayed.replayed).toBe(true)
		// Never in the live panel, whatever its saved status says: that panel
		// answers "what is running now", and nothing here is.
		expect(activeSubagentCohorts([replayed])).toEqual([])

		// And the correction path cannot reach it. `send_message` records
		// through the LIVE monitor, which has never heard of this child, so a
		// correction aimed at its task id finds nothing to write on.
		const live = new SubagentActivityMonitor()
		live.recordMessage(String(replayed.taskId), 'stop and report', 'to-child')
		expect(live.getSnapshot()).toEqual([])
	})

	it('never shares a screen or phase identity with a live child', async () => {
		const root = await sessionsRoot()
		await persistChild(root, childEvents())
		const found = await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION })
		const [replayed] = await replaySavedChildren(found)
		const live = liveProjection(childEvents())
		if (!replayed) throw new Error('the replay projected nothing')

		// Both monitors count from one. Every surface looks a child up by
		// `viewId` and groups phases by `phaseId` alone, so a shared string
		// would put two unrelated children behind one row.
		expect(replayed.viewId).not.toBe(live.viewId)
		expect(replayed.phaseId).not.toBe(live.phaseId)

		// And reading the same evidence again produces the same identity, so
		// re-opening the cockpit does not move the operator's selection.
		const [again] = await replaySavedChildren(found)
		expect(again?.viewId).toBe(replayed.viewId)
	})

	it('opens a truncated transcript as partial', async () => {
		const root = await sessionsRoot()
		const dir = await persistChild(root, childEvents())
		// The shape a process killed mid-append leaves: a final record with no
		// newline after it.
		await appendFile(join(dir, 'transcript.jsonl'), '{"type":"tool_exec', 'utf-8')

		const [replayed] = await replaySavedChildren(
			await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION }),
		)
		if (!replayed) throw new Error('the replay projected nothing')

		// Everything intact is still shown, and the transcript says why it may
		// be shorter than the run was.
		expect(replayed.transcript.map((row) => row.text)).toEqual([
			'Read(src/a.ts)',
			PARTIAL_EVIDENCE_NOTICE,
		])
		expect(replayed.status).toBe('completed')
	})

	it('still opens a child whose transcript cannot be read at all', async () => {
		const root = await sessionsRoot()
		const dir = await persistChild(root, productionChildEvents(), productionChildRun())
		// Unreadable by both the strict and the tolerant read: the tolerant one
		// skips a torn RECORD, and this is a file it cannot open.
		await rm(join(dir, 'transcript.jsonl'))
		await mkdir(join(dir, 'transcript.jsonl'))

		LOG.warn.mockClear()
		const [replayed] = await replaySavedChildren(
			await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION }),
			LOG,
		)
		if (!replayed) throw new Error('the child was dropped rather than opened as partial')

		// Dropping the row would have said this child never existed. What
		// `run.json` recorded is still true and still shown, under a notice
		// saying the record is incomplete.
		expect(replayed.transcript.map((row) => row.text)).toEqual([PARTIAL_EVIDENCE_NOTICE])
		expect(replayed.status).toBe('completed')
		expect(replayed.tokens).toBe(900)
		expect(LOG.warn).toHaveBeenCalled()
	})

	it('reports a child whose run.json never landed as the transcript left it', async () => {
		const root = await sessionsRoot()
		const base = join(root, CHILD_SESSION, 'runs')
		const store = new RunDiskStore({ baseDir: base, logger: LOG })
		await store.initRun(CHILD_RUN, PARENT_RUN)
		for (const event of childEvents().slice(0, 3)) await store.appendEvent(event)

		// No `run.json`: the listing has nothing to describe the run with, so
		// it reports no row rather than inventing one. The transcript stays on
		// disk for anything that knows the id.
		expect(await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION })).toEqual([])
	})

	it('finds nothing for a conversation whose runs launched no children', async () => {
		const root = await sessionsRoot()
		await writeFile(join(root, PARENT_SESSION, 'runs', PARENT_RUN, 'run.json'), '{}', 'utf-8')
		expect(await listSavedChildren({ sessionsRoot: root, sessionId: PARENT_SESSION })).toEqual([])
		// And a conversation with no run directory at all is not an error.
		expect(await listSavedChildren({ sessionsRoot: root, sessionId: CHILD_SESSION })).toEqual([])
	})
})
