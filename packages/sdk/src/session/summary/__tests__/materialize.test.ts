import { describe, expect, it } from 'vitest'
import { TenantIsolationError } from '../../../session/errors.js'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import type { SummaryId, ThreadId } from '../../../types/session/ids.js'
import type { DeliverableRef } from '../deliverable.js'
import { SessionSummaryMaterializer } from '../materialize.js'
import {
	AGENT_SUMMARY_MAX_CHARS,
	AgentSummaryTooLongError,
	SessionAlreadySummarizedError,
} from '../ref.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

const tenantA = 'tnt_alpha' as TenantId
const tenantB = 'tnt_beta' as TenantId

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId }
}

function makeSummaryIdGenerator(): () => SummaryId {
	let n = 0
	return (): SummaryId => `sum_test_${++n}` as SummaryId
}

async function seedActiveSession(store: InMemorySessionStore, tenantId: TenantId) {
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const session = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantId) },
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

		expect(summary.id).toBe('sum_test_1')
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
				id: 'del_a' as DeliverableRef['id'],
				kind: 'file',
				path: 'src/foo.ts',
				contentHash: 'abc123',
				sizeBytes: 42,
			},
			{
				id: 'del_b' as DeliverableRef['id'],
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

		expect(summary.id).toBe('sum_test_1')
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
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor(tenantA) },
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
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
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
				sessionId: 'ses_missing' as SessionId,
				tenantId: tenantA,
				finalOutcome: { status: 'succeeded' },
				agentSummary: '',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toThrow(/not found/)
	})
})
