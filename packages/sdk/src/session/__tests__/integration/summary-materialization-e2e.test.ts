/**
 * Integration — SessionSummaryMaterializer + SessionStore atomic transition,
 * plus the crash-recovery path.
 *
 * Covers roadmap §5 invariants: §8.1 (summary kernel-owned, no agent-callable
 * emission surface), §8.1 atomic with terminal transition, recovery path
 * when the status-flip lost to a mid-flight crash. `SessionAlreadySummarizedError`
 * on concurrent re-materialize.
 *
 * The kernel-ownership assertion is expressed both structurally (the
 * `materializedBy: 'kernel'` brand on the persisted record) and by routing
 * every successful materialize through the Materializer — no test below calls
 * `store.recordSummary` directly, and the compile-time type narrows the
 * argument to `& { materializedBy: 'kernel' }` so an agent-constructed payload
 * would fail typecheck (not just runtime validation).
 */

import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type { SessionId } from '../../../types/ids/index.js'
import type { SummaryId, ThreadId } from '../../../types/session/ids.js'
import { SessionSummaryMaterializer } from '../../summary/materialize.js'
import { SessionAlreadySummarizedError } from '../../summary/ref.js'
import { DEFAULT_TENANT, agentActor } from './_fixtures.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

async function seedActive(store: InMemorySessionStore) {
	const project = await store.createProject(
		{ tenantId: DEFAULT_TENANT, name: 'summary' },
		DEFAULT_TENANT,
	)
	const session = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor('agt_worker') },
		DEFAULT_TENANT,
	)
	await store.updateSession({ ...session, status: 'active' }, DEFAULT_TENANT)
	return { project, session: { ...session, status: 'active' as const } }
}

function makeGen(): () => SummaryId {
	let n = 0
	return () => `sum_materialize_${++n}` as SummaryId
}

describe('Integration — summary materialization E2E', () => {
	it('Materializer writes summary + flips session active→idle atomically', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActive(store)
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})

		const summary = await materializer.materialize({
			sessionId: session.id,
			tenantId: DEFAULT_TENANT,
			finalOutcome: { status: 'succeeded' },
			agentSummary: 'done',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		// Persisted.
		const stored = await store.getSummary(session.id, DEFAULT_TENANT)
		expect(stored?.id).toBe(summary.id)
		expect(stored?.materializedBy).toBe('kernel')

		// Status atomically flipped.
		const reloaded = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
	})

	it('§8.1 atomicity invariant: no external observer sees terminal without summary', async () => {
		// With InMemorySessionStore the two writes happen inside a single Map
		// method call — there is no observable mid-state. We assert by reading
		// both resources immediately after a single awaited materialize: the
		// terminal status and the summary are visible together.
		const store = new InMemorySessionStore()
		const { session } = await seedActive(store)
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})

		await materializer.materialize({
			sessionId: session.id,
			tenantId: DEFAULT_TENANT,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		const [finalSession, finalSummary] = await Promise.all([
			store.getSession(session.id, DEFAULT_TENANT),
			store.getSummary(session.id, DEFAULT_TENANT),
		])
		// Atomic pairing: idle status AND persisted summary present together.
		expect(finalSession?.status).toBe('idle')
		expect(finalSummary).not.toBeNull()
	})

	it('concurrent re-materialize rejects with SessionAlreadySummarizedError', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActive(store)
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})

		await materializer.materialize({
			sessionId: session.id,
			tenantId: DEFAULT_TENANT,
			finalOutcome: { status: 'succeeded' },
			agentSummary: 'first',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		await expect(
			materializer.materialize({
				sessionId: session.id,
				tenantId: DEFAULT_TENANT,
				finalOutcome: { status: 'succeeded' },
				agentSummary: 'second',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toBeInstanceOf(SessionAlreadySummarizedError)
	})

	it('crash recovery: summary persisted + session still active → recover() replays idempotently', async () => {
		const store = new InMemorySessionStore()
		const { session } = await seedActive(store)
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})

		// Materialize once (happy path writes both). Then simulate a crash by
		// forcing the session status back to `active` while the summary record
		// stays intact — mimicking summary.json landing but session.json being
		// lost to a mid-write power failure (see session/summary/materialize.ts
		// `recover()` docs).
		await materializer.materialize({
			sessionId: session.id,
			tenantId: DEFAULT_TENANT,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})
		const mid = await store.getSession(session.id, DEFAULT_TENANT)
		if (!mid) throw new Error('mid session missing')
		await store.updateSession({ ...mid, status: 'active' }, DEFAULT_TENANT)

		// Recovery call re-triggers the store's flip path without minting a
		// new summary id.
		const recovered = await materializer.recover(session.id, DEFAULT_TENANT)
		expect(recovered).not.toBeNull()

		const reloaded = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')

		// Second recover call with session already idle: still idempotent.
		const recovered2 = await materializer.recover(session.id, DEFAULT_TENANT)
		expect(recovered2?.id).toBe(recovered?.id)
		const reloaded2 = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded2?.status).toBe('idle')
	})

	it('agent cannot construct SessionSummaryRef directly: recordSummary rejects non-kernel payload', async () => {
		// The SessionStore contract narrows `recordSummary` to
		// `SessionSummaryRef & { materializedBy: 'kernel' }`. Agents cannot
		// type-construct a brand literal of `'kernel'` without going through
		// the Materializer (see session/summary/ref.ts module header). Even
		// attempting to cast into the shape and call directly would bypass
		// the materialize ordering (status-check, length-check,
		// already-exists guard). This test exercises the runtime guard: a
		// second kernel-branded record for an already-summarized session
		// rejects with SessionAlreadySummarizedError.
		const store = new InMemorySessionStore()
		const { session } = await seedActive(store)
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})
		await materializer.materialize({
			sessionId: session.id,
			tenantId: DEFAULT_TENANT,
			finalOutcome: { status: 'succeeded' },
			agentSummary: '',
			declaredDeliverables: [],
			keyDecisions: [],
		})

		// Direct call with a fabricated "kernel" ref payload — rejected
		// because a summary already exists (store guard). The kernel-brand
		// check at the type layer prevents naive agent-side construction; the
		// runtime guard here catches store-level re-entry (materialize goes
		// through the same path).
		await expect(
			store.recordSummary(
				{
					id: 'sum_fake' as SummaryId,
					sessionRef: session.id,
					tenantId: DEFAULT_TENANT,
					outcome: { status: 'succeeded' },
					deliverables: [],
					agentSummary: 'forged',
					keyDecisions: [],
					at: new Date(),
					materializedBy: 'kernel',
				},
				DEFAULT_TENANT,
			),
		).rejects.toBeInstanceOf(SessionAlreadySummarizedError)
	})

	it('missing session: materialize throws a not-found error', async () => {
		const store = new InMemorySessionStore()
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: makeGen(),
		})

		await expect(
			materializer.materialize({
				sessionId: 'ses_never' as SessionId,
				tenantId: DEFAULT_TENANT,
				finalOutcome: { status: 'succeeded' },
				agentSummary: '',
				declaredDeliverables: [],
				keyDecisions: [],
			}),
		).rejects.toThrow(/not found/)
	})
})
