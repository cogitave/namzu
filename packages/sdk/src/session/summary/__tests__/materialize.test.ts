import { describe, expect, it } from 'vitest'
import { TenantIsolationError } from '../../../session/errors.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { fixtureUuid } from '../../../test-support/ids.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { SummaryId, TopicId } from '../../../types/session/ids.js'
import type { DeliverableRef } from '../../../types/summary/deliverable.js'
import { AGENT_SUMMARY_MAX_CHARS } from '../../../types/summary/ref.js'
import { AgentSummaryTooLongError, SessionAlreadySummarizedError } from '../errors.js'
import { SessionSummaryMaterializer } from '../materialize.js'

const TEST_THREAD_ID = '4bd72c65-bcc9-475c-8d7c-27d622df04e8' as TopicId

const tenantA = '62edaf4a-e86a-4e8e-bb39-662d7437216e' as TenantId
const tenantB = '87db2e41-8862-4b94-a8d0-9b6898ce8ba7' as TenantId

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: '9ce05013-3bcc-4835-86b3-15e7b9251801' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: '297e7108-719e-42f6-aa3b-f3b42d1ad2c5' as AgentId, tenantId }
}

function makeSummaryIdGenerator(): () => SummaryId {
	let n = 0
	return (): SummaryId => fixtureUuid(`sum_test_${++n}`) as SummaryId
}

async function seedActiveSession(store: InMemorySessionStore, tenantId: TenantId) {
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const session = await store.createSession(
		{ topicId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantId) },
		tenantId,
	)
	// Put the session into `active` so the materializer's status-flip behavior
	// is observable.
	await store.updateSession({ ...session, status: 'active' }, tenantId)
	return { project, session: { ...session, status: 'active' as const } }
}

function buildMaterializer(store: InMemorySessionStore) {
	return new SessionSummaryMaterializer({
		store,
		generateSummaryId: makeSummaryIdGenerator(),
		now: () => new Date('2026-04-17T00:00:00Z'),
	})
}

describe('SessionSummaryMaterializer.materialize', () => {
	it('materializes on an active session and flips status to idle', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded', verdict: 'done' },
			agentSummary: 'Completed task X.',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		expect(summary.id).toBe('54a56ad7-462a-4f3f-b039-4f0f89a21fb0')
		expect(summary.sessionRef).toBe(session.id)
		expect(summary.materializedBy).toBe('kernel')

		const stored = await store.getSummary(session.id, tenantA)
		expect(stored?.id).toBe(summary.id)

		const reloaded = await store.getSession(session.id, tenantA)
		expect(reloaded?.status).toBe('idle')
	})

	it('rejects an agentSummary exceeding AGENT_SUMMARY_MAX_CHARS', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		await expect(
			materializer.materialize({
				sessionId: session.id,
				tenantId: tenantA,
				finalOutcome: { status: 'succeeded' },
				agentSummary: 'x'.repeat(AGENT_SUMMARY_MAX_CHARS + 1),
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toBeInstanceOf(AgentSummaryTooLongError)
	})

	it('rejects re-materialization when a summary already exists', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: 'first',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		await expect(
			materializer.materialize({
				sessionId: session.id,
				tenantId: tenantA,
				finalOutcome: { status: 'succeeded' },
				agentSummary: 'second',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toBeInstanceOf(SessionAlreadySummarizedError)
	})

	it('rejects cross-tenant materialize with TenantIsolationError', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		await expect(
			materializer.materialize({
				sessionId: session.id,
				tenantId: tenantB,
				finalOutcome: { status: 'succeeded' },
				agentSummary: 'x',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('preserves declaredDeliverables verbatim in the emitted ref', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		const deliverables: DeliverableRef[] = [
			{
				id: '3aa98b45-606d-4b8f-bf78-db81dfedd8a4' as DeliverableRef['id'],
				kind: 'file',
				path: 'src/foo.ts',
				contentHash: 'abc123',
				sizeBytes: 42,
			},
			{
				id: 'ab33b451-0894-4f9f-8457-243e9f6a0299' as DeliverableRef['id'],
				kind: 'artifact_blob',
				storageRef: 'blob://x',
				mediaType: 'application/json',
			},
		]

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'partial' },
			agentSummary: '',
			declaredDeliverables: deliverables,
			keyDecisions: [],
		})

		expect(summary.deliverables).toEqual(deliverables)
	})

	it('preserves keyDecisions verbatim in the emitted ref', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		const decisions = [
			{ at: new Date('2026-04-17T01:00:00Z'), summary: 'plan approved' },
			{ at: new Date('2026-04-17T02:00:00Z'), summary: 'hitl granted' },
		]

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: decisions,
		})

		expect(summary.keyDecisions).toEqual(decisions)
	})

	it('constructs SummaryId via the injected generator', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)

		const gen = makeSummaryIdGenerator()
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: gen,
		})

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		expect(summary.id).toBe('54a56ad7-462a-4f3f-b039-4f0f89a21fb0')
	})

	it('always sets materializedBy to "kernel"', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		expect(summary.materializedBy).toBe('kernel')
	})

	it('leaves already-idle sessions in idle (no spurious flip)', async () => {
		const store = new InMemorySessionStore()
		const project = await store.createProject({ tenantId: tenantA, name: 'p1' }, tenantA)
		const session = await store.createSession(
			{ topicId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor(tenantA) },
			tenantA,
		)
		// session.status defaults to 'idle'
		const materializer = buildMaterializer(store)

		await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		const reloaded = await store.getSession(session.id, tenantA)
		expect(reloaded?.status).toBe('idle')
	})

	it('leaves failed sessions in failed (materialize does not resurrect)', async () => {
		const store = new InMemorySessionStore()
		const project = await store.createProject({ tenantId: tenantA, name: 'p1' }, tenantA)
		const session = await store.createSession(
			{ topicId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		await store.updateSession({ ...session, status: 'failed' }, tenantA)
		const materializer = buildMaterializer(store)

		await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'failed', verdict: 'gave up' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		const reloaded = await store.getSession(session.id, tenantA)
		expect(reloaded?.status).toBe('failed')
	})
})

describe('SessionSummaryMaterializer.recover', () => {
	it('returns null when no summary file exists (no side effect)', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		const recovered = await materializer.recover(session.id, tenantA)
		expect(recovered).toBeNull()

		const reloaded = await store.getSession(session.id, tenantA)
		// No side effect — still active.
		expect(reloaded?.status).toBe('active')
	})

	it('flips dangling session status idempotently when summary is present', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActiveSession(store, tenantA)
		const materializer = buildMaterializer(store)

		// Simulate mid-crash: write summary directly, then force session back to
		// active (mimicking a process death between the two atomic writes).
		await materializer.materialize({
			sessionId: session.id,
			tenantId: tenantA,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})
		const mid = await store.getSession(session.id, tenantA)
		if (!mid) throw new Error('seed mid session missing')
		await store.updateSession({ ...mid, status: 'active' }, tenantA)

		const recovered = await materializer.recover(session.id, tenantA)
		expect(recovered).not.toBeNull()

		const reloaded = await store.getSession(session.id, tenantA)
		expect(reloaded?.status).toBe('idle')

		// Idempotent: calling recover again with session already idle is a no-op.
		const recovered2 = await materializer.recover(session.id, tenantA)
		expect(recovered2?.id).toBe(recovered?.id)
		const reloaded2 = await store.getSession(session.id, tenantA)
		expect(reloaded2?.status).toBe('idle')
	})
})

describe('SessionSummaryMaterializer missing session', () => {
	it('throws when the session does not exist', async () => {
		const store = new InMemorySessionStore()
		const materializer = buildMaterializer(store)

		await expect(
			materializer.materialize({
				sessionId: '1ef9ce34-f888-4928-9659-b4f6388670a9' as SessionId,
				tenantId: tenantA,
				finalOutcome: { status: 'succeeded' },
				agentSummary: '',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toThrow(/not found/)
	})
})
