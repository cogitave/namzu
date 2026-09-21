import { describe, expect, it, vi } from 'vitest'

import { TurnRecorder } from '../../../manager/session/turn-recorder.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { InMemoryTaskStore } from '../../../store/task/memory.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
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

const TURN = 'b20a3380-db4f-47a7-b446-d48bcbbbdfef' as TurnId
const SESSION = '661ca27b-88d4-4c9c-9c61-a2f296ac9aae' as SessionId

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

/**
 * The real `TurnRecorder`, over an in-memory session log.
 *
 * This was a hand-written object with an `id` and a stub store getter, and it
 * kept growing a member behind the emitter: first a store, because `emitEvent`
 * appends and a fake without one produced an unhandled rejection AFTER the
 * assertions passed — green tests, non-zero exit; then the event-sequence
 * counter. The fixture was tracking production one discovery at a time, which
 * is the shape the rule about fixtures unlike production names. Using the real
 * class ends that: the next member the emitter reaches for is simply there.
 */
function persistence(): TurnRecorder {
	return new TurnRecorder({
		turnId: TURN,
		agentId: 'a',
		agentName: 'A',
		turnConfig: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
		providerId: 'mock',
		log: LOG,
		sessionId: SESSION,
		topicId: 'bcc64cd7-b81a-4dff-a633-203f1a03a837',
		projectId: 'b0f376f8-52af-4302-bf4f-d7bcf3cf34c3',
		tenantId: 'a8bb2035-b5d5-4866-815b-a67fc7085cc6',
		// Nothing may be written to disk: the log is held in memory.
		sessionLog: new InMemorySessionLog({ sessionId: SESSION }),
		// biome-ignore lint/suspicious/noExplicitAny: branded id types are not
		// what this test is about; the wiring is.
	} as any)
}

async function capture(body: (store: InMemoryTaskStore) => Promise<void>): Promise<SessionEvent[]> {
	const store = new InMemoryTaskStore()
	const recorder = persistence()
	await recorder.open({ session: { cwd: '/tmp' } })
	await recorder.begin()
	const emitter = new EventTranslator(recorder)
	const stop = emitter.wireTaskStore(store, SESSION)

	await body(store)
	// The store's listeners are async; let them settle before draining.
	await new Promise((resolve) => setTimeout(resolve, 20))
	stop()

	return [...emitter.drainPending()]
}

type Created = Extract<SessionEvent, { type: 'task_created' }>
type Updated = Extract<SessionEvent, { type: 'task_updated' }>

describe('a host can see what a unit waits on', () => {
	it('carries the edges once a dependency exists', async () => {
		const events = await capture(async (store) => {
			const gather = await store.create({ sessionId: SESSION, turnId: TURN, subject: 'gather' })
			const summarise = await store.create({
				sessionId: SESSION,
				turnId: TURN,
				subject: 'summarise',
			})
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
			await store.create({ sessionId: SESSION, turnId: TURN, subject: 'standalone' })
		})

		const created = events.find((e): e is Created => e.type === 'task_created')

		expect(created).toBeDefined()
		expect(created && 'blockedBy' in created).toBe(false)
	})
})
