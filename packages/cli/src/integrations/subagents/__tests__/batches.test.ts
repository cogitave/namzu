import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { endChild, logHome, parentSession, spawnChild } from '../__fixtures__/session-logs.js'
import { DEFAULT_AGENT_PHASE, DEFAULT_AGENT_WORKFLOW, type SubagentActivity } from '../activity.js'
import {
	type Batch,
	MAX_LISTED_BATCHES,
	combineBatches,
	listSavedBatches,
	liveBatches,
} from '../batches.js'

function agent(
	input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
): SubagentActivity {
	return {
		viewId: input.viewId,
		agentId: input.agentId ?? 'general-purpose',
		description: input.description ?? input.viewId,
		prompt: input.prompt ?? '',
		batchId: input.batchId ?? 'batch-1',
		workflowId: input.workflowId ?? 'turn-1',
		workflowGroupId: input.workflowGroupId ?? 'group-1',
		phaseId: input.phaseId ?? 'phase-1',
		workflow: input.workflow ?? DEFAULT_AGENT_WORKFLOW,
		phase: input.phase ?? 'Work',
		phaseSequence: input.phaseSequence ?? 1,
		status: input.status ?? 'working',
		startedAt: input.startedAt ?? 0,
		transcript: input.transcript ?? [],
		...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.replayed ? { replayed: true } : {}),
	}
}

function batch(over: Partial<Batch> = {}): Batch {
	return {
		id: 'turn-1',
		name: 'Work',
		startedAt: 0,
		phases: ['Work'],
		agentsDone: 0,
		agentsTotal: 1,
		tokensTotal: 0,
		elapsedMs: 0,
		live: false,
		...over,
	}
}

describe('liveBatches', () => {
	it('groups by parent turn id, joining phases in launch order and summing tokens', () => {
		const batches = liveBatches(
			[
				agent({
					viewId: 'a',
					workflowId: 'turn-1',
					workflow: 'Auth refactor',
					phase: 'Explore',
					phaseSequence: 1,
					startedAt: 1_000,
					tokens: 40,
				}),
				agent({
					viewId: 'b',
					workflowId: 'turn-1',
					workflow: 'Auth refactor',
					phase: 'Implement',
					phaseSequence: 2,
					startedAt: 2_000,
					status: 'completed',
					completedAt: 3_000,
					tokens: 60,
				}),
			],
			10_000,
		)

		expect(batches).toEqual([
			{
				id: 'turn-1',
				name: 'Auth refactor',
				startedAt: 1_000,
				phases: ['Explore', 'Implement'],
				agentsDone: 1,
				agentsTotal: 2,
				tokensTotal: 100,
				elapsedMs: 9_000,
				live: true,
			},
		])
	})

	it('excludes a group every one of whose members has already settled', () => {
		// A finished batch belongs to the session index, where the parent's log
		// is the record of fact — not here, which would be a second account.
		const batches = liveBatches(
			[agent({ viewId: 'a', workflowId: 'turn-done', status: 'completed', completedAt: 500 })],
			1_000,
		)
		expect(batches).toEqual([])
	})

	it('excludes replayed rows even when their saved status was never terminal', () => {
		const batches = liveBatches(
			[agent({ viewId: 'a', workflowId: 'turn-1', status: 'working', replayed: true })],
			1_000,
		)
		expect(batches).toEqual([])
	})

	it('reports the neutral default when no workflow label was ever set', () => {
		const batches = liveBatches([agent({ viewId: 'a', workflowId: 'turn-1' })], 1_000)
		expect(batches[0]?.name).toBe(DEFAULT_AGENT_WORKFLOW)
	})
})

describe('combineBatches', () => {
	it('keeps the live row for a turn both sources name, newest first', () => {
		const live = batch({ id: 'turn-a', startedAt: 5, live: true, agentsDone: 1 })
		const stale = batch({ id: 'turn-a', startedAt: 5 })
		const other = batch({ id: 'turn-b', startedAt: 9 })

		const listing = combineBatches([live], [stale, other])

		expect(listing.batches).toEqual([other, live])
		expect(listing.omitted).toBe(0)
	})

	it(`shows at most ${MAX_LISTED_BATCHES} and counts the rest`, () => {
		const finished = Array.from({ length: MAX_LISTED_BATCHES + 3 }, (_, index) =>
			batch({ id: `turn-${index}`, startedAt: index }),
		)
		const listing = combineBatches([], finished)
		expect(listing.batches).toHaveLength(MAX_LISTED_BATCHES)
		expect(listing.batches[0]?.id).toBe(`turn-${MAX_LISTED_BATCHES + 2}`)
		expect(listing.omitted).toBe(3)
	})
})

describe('listSavedBatches', () => {
	const roots: string[] = []
	afterEach(() => {
		for (const root of roots.splice(0)) removeTempDir(root)
	})

	it('groups children by parent turn, named and phased from the recorded batch', async () => {
		const fixture = await logHome()
		roots.push(fixture.root)
		const parent = await parentSession(fixture)
		const a = await spawnChild(fixture, parent, {
			description: 'read the diff',
			batch: { batchId: 'batch-1', name: 'Release audit', phase: 'Research' },
		})
		const b = await spawnChild(fixture, parent, {
			description: 'verify the build',
			batch: { batchId: 'batch-2', name: 'Release audit', phase: 'Verify' },
		})
		await endChild(parent, a.sessionId, 'completed', 400)
		await endChild(parent, b.sessionId, 'failed', 200)

		const batches = await listSavedBatches({
			index: await fixture.index(),
			paths: fixture.paths,
			session: { sessionId: parent.sessionId },
		})

		expect(batches).toHaveLength(1)
		expect(batches[0]).toMatchObject({
			id: parent.turnId,
			name: 'Release audit',
			phases: ['Research', 'Verify'],
			agentsDone: 2,
			agentsTotal: 2,
			tokensTotal: 600,
			live: false,
		})
	})

	it('names unlabelled work from the opening words of the parent turn', async () => {
		const fixture = await logHome()
		roots.push(fixture.root)
		const parent = await parentSession(fixture, 'Tidy the\nchangelog')
		const child = await spawnChild(fixture, parent, { description: 'tidy' })

		const [saved] = await listSavedBatches({
			index: await fixture.index(),
			paths: fixture.paths,
			session: { sessionId: parent.sessionId },
		})

		// Still running: no ending was recorded, so it is not done and has spent
		// nothing the parent knows of.
		expect(saved).toMatchObject({
			id: parent.turnId,
			name: 'Tidy the changelog',
			phases: [DEFAULT_AGENT_PHASE],
			agentsDone: 0,
			agentsTotal: 1,
			tokensTotal: 0,
		})
		expect(child.sessionId).toBeTruthy()
	})

	it('reports no batches for a conversation that never delegated anything', async () => {
		const fixture = await logHome()
		roots.push(fixture.root)
		const parent = await parentSession(fixture)
		expect(
			await listSavedBatches({
				index: await fixture.index(),
				paths: fixture.paths,
				session: { sessionId: parent.sessionId },
			}),
		).toEqual([])
	})
})
