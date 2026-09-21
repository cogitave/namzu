import { appendFile, mkdir, rm } from 'node:fs/promises'

import {
	type MessageId,
	type SessionEvent,
	type SessionId,
	type SessionRecordDraft,
	type TurnId,
	generateMessageId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { activeSubagentCohorts } from '../../../tui/AgentExplorer.js'
import {
	type LogHome,
	type LogWriter,
	ZERO_COST,
	endChild,
	logHome,
	parentSession,
	spawnChild,
	usage,
} from '../__fixtures__/session-logs.js'
import {
	PARTIAL_EVIDENCE_NOTICE,
	type SubagentActivity,
	SubagentActivityMonitor,
} from '../activity.js'
import { type SavedChildScope, listSavedChildren, replaySavedChildren } from '../replay.js'

/**
 * One projection, two sources.
 *
 * The cockpit renders a live child and a finished one through the same
 * `SubagentActivity`, and the only way that stays true is for both to come
 * out of the same projection. A replay that grew its own would not fail
 * loudly — it would drift, one field at a time, until the past rendered
 * differently from the present. The equality test below is the guard for
 * that, and it is the reason this file exists.
 */

const NOW = 1_700_000_000_000
const BATCH = { batchId: 'batch-1', name: 'Ship it', phase: 'Review' }

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const roots: string[] = []
let clock = NOW
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
	vi.restoreAllMocks()
})

beforeEach(() => {
	// Both paths stamp their own clock — `begin()` for `startedAt`, the log
	// for every record's `ts` — so the clock has to be under the test's hand
	// for "equal" to mean anything about the projection.
	clock = NOW
	vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

async function home(): Promise<LogHome> {
	const fixture = await logHome()
	roots.push(fixture.root)
	return fixture
}

function scope(fixture: LogHome, sessionId: SessionId, index: SavedChildScope['index']) {
	return { index, paths: fixture.paths, session: { sessionId } }
}

/** What a child's own log holds after one turn that read a file and answered. */
async function childTurn(
	writer: LogWriter,
	sessionId: SessionId,
	options: { readonly answer?: string; readonly settle?: boolean } = {},
): Promise<{
	readonly turnId: TurnId
	readonly answerId: MessageId
	readonly live: SessionEvent[]
}> {
	const turnId = generateTurnId()
	const userMessageId = await writer.beginTurn(turnId, 'review the diff')
	const answerId = generateMessageId()
	const answer = options.answer ?? 'found it'
	await writer.append({
		type: 'message',
		turnId,
		messageId: answerId,
		role: 'assistant',
		content: { role: 'assistant', content: answer },
	} as SessionRecordDraft)
	const tool = {
		type: 'tool_executing',
		turnId,
		iteration: 1,
		toolUseId: 'tool-1',
		toolName: 'Read',
		input: { path: 'src/a.ts' },
		isDestructive: false,
	}
	const done = {
		type: 'tool_completed',
		turnId,
		iteration: 1,
		toolUseId: 'tool-1',
		toolName: 'Read',
		result: 'two hundred lines',
		isError: false,
	}
	const spent = {
		type: 'token_usage_updated',
		turnId,
		iteration: 1,
		usage: usage(600),
		cost: ZERO_COST,
	}
	await writer.append(tool as SessionRecordDraft)
	await writer.append(done as SessionRecordDraft)
	await writer.append(spent as SessionRecordDraft)
	if (options.settle !== false) await writer.completeTurn(turnId, answer, 600)
	// The same turn as the live stream delivered it: the answer arrived as
	// deltas (which never reach a log), everything else as the events the log
	// recorded.
	const live = [
		{
			type: 'turn_started',
			sessionId,
			turnId,
			userMessageId,
			config: { model: 'a-model', tokenBudget: 0, timeoutMs: 0 },
		},
		{ type: 'text_delta', sessionId, turnId, iteration: 1, messageId: answerId, text: 'found ' },
		{ type: 'text_delta', sessionId, turnId, iteration: 1, messageId: answerId, text: 'it' },
		{ ...tool, sessionId },
		{ ...done, sessionId },
		{ ...spent, sessionId },
	] as unknown as SessionEvent[]
	return { turnId, answerId, live }
}

/** The same child through the live path, seeded the way replay seeds itself. */
function liveProjection(workflowId: string, events: readonly SessionEvent[]): SubagentActivity {
	const monitor = new SubagentActivityMonitor()
	const tracker = monitor.begin({
		agentId: 'reviewer',
		model: 'a-model',
		description: 'review',
		prompt: 'review the diff',
		batchId: BATCH.batchId,
		workflowId,
		workflow: BATCH.name,
		phase: BATCH.phase,
	})
	for (const event of events) tracker.onEvent(event)
	const [activity] = monitor.getSnapshot()
	if (!activity) throw new Error('the live monitor projected nothing')
	return activity
}

/**
 * One activity wearing another's ALLOCATED ids — the screen identity and the
 * phase identity a monitor mints for itself, plus the row ids that carry the
 * first as a prefix. Neither is a projected fact.
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

describe('a finished delegated child, reopened from its log', () => {
	it('projects to exactly what the live path produced from the same turn', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review', batch: BATCH })
		const { live } = await childTurn(child.writer, child.sessionId)
		await endChild(parent, child.sessionId, 'completed', 600)

		const index = await fixture.index()
		const found = await listSavedChildren(scope(fixture, parent.sessionId, index))
		expect(found.map((saved) => saved.sessionId)).toEqual([child.sessionId])

		const [replayed] = await replaySavedChildren(found)
		if (!replayed) throw new Error('the replay projected nothing')

		// The live tracker learns the ending from the parent's relayed
		// `agent_completed`; the replay learns it from `child_session_ended`.
		const livePath = liveProjection(parent.turnId, [
			...live,
			{
				type: 'agent_completed',
				sessionId: parent.sessionId,
				turnId: parent.turnId,
				taskId: 'task-1',
				result: { status: 'completed', stopReason: 'end_turn' },
			} as unknown as SessionEvent,
		])

		// Three fields may differ, and only these three: `replayed` is what the
		// saved view adds; `viewId` and `phaseId` are identities each monitor
		// allocates for itself.
		const { replayed: marker, ...projected } = replayed
		expect(marker).toBe(true)
		expect(replayed.viewId).toBe(`saved-${child.sessionId}`)
		expect(replayed.phaseId.startsWith('saved-phase-')).toBe(true)
		expect(
			asAllocatedIds(projected as SubagentActivity, {
				viewId: livePath.viewId,
				phaseId: livePath.phaseId,
			}),
		).toEqual(livePath)

		// Named explicitly as well, so a regression reports which field moved.
		expect(replayed.status).toBe('completed')
		expect(replayed.sessionId).toBe(child.sessionId)
		expect(replayed.model).toBe('a-model')
		expect(replayed.prompt).toBe('review the diff')
		expect(replayed.tokens).toBe(600)
		expect(replayed.toolCalls).toBe(1)
		expect(replayed.workflow).toBe('Ship it')
		expect(replayed.phase).toBe('Review')
		expect(replayed.workflowId).toBe(parent.turnId)
		expect(replayed.transcript.map((row) => row.text)).toEqual(['found it', 'Read(src/a.ts)'])
	})

	it('takes status, timings and totals from the parent log where the child log disagrees', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		clock = NOW - 5_000
		const child = await spawnChild(fixture, parent, { description: 'review' })
		await childTurn(child.writer, child.sessionId)
		clock = NOW - 1_000
		await endChild(parent, child.sessionId, 'completed', 900)
		clock = NOW

		const [replayed] = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
		)
		if (!replayed) throw new Error('the replay projected nothing')

		// Each differs from what the child's own events say, so deleting the
		// overlay fails here rather than passing quietly.
		expect(replayed.status).toBe('completed')
		expect(replayed.tokens).toBe(900) // `token_usage_updated` said 600
		expect(replayed.startedAt).toBe(NOW - 5_000) // `begin()` stamps NOW
		expect(replayed.completedAt).toBe(NOW - 1_000)
		expect(replayed.latestActivity).toBe('Completed')
		// No label was recorded: grouped by the parent turn under the default.
		expect(replayed.phaseDetail).toBeUndefined()
		expect(replayed.phaseOrder).toBeUndefined()
		expect(replayed.workflowId).toBe(parent.turnId)
		expect(replayed.batchId).toBe(`saved:${parent.turnId}`)
	})

	it("falls back to the child's own settled turn when the parent recorded no ending", async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const settled = await spawnChild(fixture, parent, { description: 'settled' })
		await childTurn(settled.writer, settled.sessionId)
		const killed = await spawnChild(fixture, parent, { description: 'killed' })
		await childTurn(killed.writer, killed.sessionId, { settle: false })

		const replayed = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
		)
		const byDescription = new Map(replayed.map((row) => [row.description, row]))

		expect(byDescription.get('settled')?.status).toBe('completed')
		expect(byDescription.get('settled')?.tokens).toBe(600)
		// A child killed mid-turn recorded no ending anywhere. It stays as the
		// events left it, never rewritten to a terminal status.
		expect(byDescription.get('killed')?.status).toBe('working')
		expect(byDescription.get('killed')?.replayed).toBe(true)
	})

	it('shows the answer a guardrail replaced, never the raw one', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review' })
		const { turnId, answerId } = await childTurn(child.writer, child.sessionId, {
			answer: 'the secret is hunter2',
			settle: false,
		})
		await child.writer.append({
			type: 'message_replaced',
			targetMessageId: answerId,
			content: { role: 'assistant', content: '[redacted]' },
			reason: 'guardrail_rewritten',
		} as SessionRecordDraft)
		await child.writer.completeTurn(turnId, '[redacted]', 600)

		const [replayed] = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
		)
		const texts = replayed?.transcript.map((row) => row.text) ?? []
		expect(texts).toContain('[redacted]')
		expect(texts.join('\n')).not.toContain('hunter2')
	})

	it('is marked replayed and offers no continuation', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review' })
		await childTurn(child.writer, child.sessionId)
		await endChild(parent, child.sessionId, 'completed', 600)
		const [replayed] = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
		)
		if (!replayed) throw new Error('the replay projected nothing')

		expect(replayed.replayed).toBe(true)
		// Never in the live panel, whatever its saved status says.
		expect(activeSubagentCohorts([replayed])).toEqual([])
		// And the correction path cannot reach it: the live monitor has never
		// heard of this child.
		const live = new SubagentActivityMonitor()
		live.recordMessage(String(replayed.taskId), 'stop and report', 'to-child')
		expect(live.getSnapshot()).toEqual([])
	})

	it('never shares a screen or phase identity with a live child, and keeps its own across reads', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review', batch: BATCH })
		const { live } = await childTurn(child.writer, child.sessionId)
		const found = await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index()))
		const [replayed] = await replaySavedChildren(found)
		const livePath = liveProjection(parent.turnId, live)
		if (!replayed) throw new Error('the replay projected nothing')

		expect(replayed.viewId).not.toBe(livePath.viewId)
		expect(replayed.phaseId).not.toBe(livePath.phaseId)
		const [again] = await replaySavedChildren(found)
		expect(again?.viewId).toBe(replayed.viewId)
	})

	it('opens a log with a torn tail as partial', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review' })
		await childTurn(child.writer, child.sessionId)
		await endChild(parent, child.sessionId, 'completed', 600)
		// The shape a process killed mid-append leaves: a final record with no
		// newline after it.
		await appendFile(child.writer.log.file, '{"v":1,"type":"tool_exec', 'utf-8')

		const [replayed] = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
		)
		expect(replayed?.transcript.map((row) => row.text)).toEqual([
			'found it',
			'Read(src/a.ts)',
			PARTIAL_EVIDENCE_NOTICE,
		])
		expect(replayed?.status).toBe('completed')
	})

	it('still opens a child whose log cannot be read at all', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const child = await spawnChild(fixture, parent, { description: 'review' })
		await childTurn(child.writer, child.sessionId)
		await endChild(parent, child.sessionId, 'completed', 900)
		await rm(child.writer.log.file)
		await mkdir(child.writer.log.file)

		LOG.warn.mockClear()
		const [replayed] = await replaySavedChildren(
			await listSavedChildren(scope(fixture, parent.sessionId, await fixture.index())),
			LOG,
		)
		if (!replayed) throw new Error('the child was dropped rather than opened as partial')

		// What the parent's log recorded is still true and still shown, under a
		// notice saying the record is incomplete.
		expect(replayed.transcript.map((row) => row.text)).toEqual([PARTIAL_EVIDENCE_NOTICE])
		expect(replayed.status).toBe('completed')
		expect(replayed.tokens).toBe(900)
		expect(LOG.warn).toHaveBeenCalled()
	})

	it('keeps the newest children, in launch order, when there are more than the bound', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		for (const [offset, description] of ['first', 'second', 'third'].entries()) {
			clock = NOW + offset * 1_000
			await spawnChild(fixture, parent, { description })
		}
		const found = await listSavedChildren({
			...scope(fixture, parent.sessionId, await fixture.index()),
			maxChildren: 2,
		})
		expect(found.map((child) => child.description)).toEqual(['second', 'third'])
	})

	it('finds nothing for a conversation that launched no children', async () => {
		const fixture = await home()
		const parent = await parentSession(fixture)
		const index = await fixture.index()
		expect(await listSavedChildren(scope(fixture, parent.sessionId, index))).toEqual([])
	})
})
