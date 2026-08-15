import { describe, expect, it, vi } from 'vitest'

import { RunPersistence } from '../../../manager/run/persistence.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import { EventTranslator } from '../events.js'

/**
 * The task store maintains a full dependency graph — `blocks` and `blockedBy`
 * mirrored on both ends, written under a lock, and deadlock-avoided — and none
 * of it reached the wire.
 *
 * So a host could draw a flat list of units and nothing about their order,
 * while the model was already maintaining the order. Two optional fields is the
 * smallest change that lets a host draw the plan the model has in mind.
 */

const RUN = 'run_graph' as RunId

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

/**
 * The real `RunPersistence`, over the in-memory run store.
 *
 * This was a hand-written object with an `id` and a stub `getRunStore`, and it
 * kept growing a member behind the emitter: first a store, because `emitEvent`
 * appends and a fake without one produced an unhandled rejection AFTER the
 * assertions passed — green tests, non-zero exit; then the event-sequence
 * counter. The fixture was tracking production one discovery at a time, which
 * is the shape the rule about fixtures unlike production names. Using the real
 * class ends that: the next member the emitter reaches for is simply there.
 */
function persistence(): RunPersistence {
	return new RunPersistence({
		runId: RUN,
		agentId: 'a',
		agentName: 'A',
		runConfig: {},
		providerId: 'mock',
		// Nothing may be written: the injected store is not a filesystem.
		outputDir: '/namzu-nonexistent-should-never-be-written',
		log: LOG,
		sessionId: 'ses_graph',
		topicId: 'top_graph',
		projectId: 'prj_graph',
		tenantId: 'tnt_graph',
		runStore: new InMemoryRunStore(),
		// biome-ignore lint/suspicious/noExplicitAny: branded id types are not
		// what this test is about; the wiring is.
	} as any)
}

async function capture(body: (store: InMemoryTaskStore) => Promise<void>): Promise<RunEvent[]> {
	const store = new InMemoryTaskStore()
	const runMgr = persistence()
	await runMgr.init()
	const emitter = new EventTranslator(runMgr)
	const stop = emitter.wireTaskStore(store, RUN)

	await body(store)
	// The store's listeners are async; let them settle before draining.
	await new Promise((resolve) => setTimeout(resolve, 20))
	stop()

	return [...emitter.drainPending()]
}

type Created = Extract<RunEvent, { type: 'task_created' }>
type Updated = Extract<RunEvent, { type: 'task_updated' }>

describe('a host can see what a unit waits on', () => {
	it('carries the edges once a dependency exists', async () => {
		const events = await capture(async (store) => {
			const gather = await store.create({ runId: RUN, subject: 'gather' })
			const summarise = await store.create({ runId: RUN, subject: 'summarise' })
			await store.block(gather.id, summarise.id)
		})

		const withEdges = events
			.filter((e): e is Updated => e.type === 'task_updated')
			.find((e) => e.blockedBy !== undefined)

		expect(withEdges, 'the dependency the store recorded never reached the wire').toBeDefined()
		expect(withEdges?.blockedBy).toHaveLength(1)
	})

	it('says nothing rather than empty when a unit depends on nothing', async () => {
		// Absent and empty are different claims. A reader must be able to tell
		// "this unit has no dependencies" from "this emitter predates the
		// field" — an empty array asserts the first about both.
		const events = await capture(async (store) => {
			await store.create({ runId: RUN, subject: 'standalone' })
		})

		const created = events.find((e): e is Created => e.type === 'task_created')

		expect(created).toBeDefined()
		expect(created && 'blockedBy' in created).toBe(false)
	})
})
