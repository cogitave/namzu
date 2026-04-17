/**
 * Integration — `active → locked` illegal-transition rejection matrix per
 * pattern doc §5.1.
 *
 * A handoff request against a session whose current Run is `running`,
 * `awaiting_hitl`, `awaiting_hitl_resolution`, or `awaiting_subsession`
 * rejects with typed {@link HandoffLockRejected}. The reason enum maps:
 *   - running              → 'active_run'
 *   - awaiting_hitl        → 'pending_hitl'
 *   - awaiting_hitl_resol. → 'pending_hitl'
 *   - awaiting_subsession  → 'pending_subsession'
 *
 * This integration test wires the `RunStatusResolver` seam into a full
 * single-handoff flow so the rejection triggers from the run-fan-in check
 * (§5.1), not just from a status precondition.
 */

import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { generateHandoffId } from '../../../utils/id.js'
import type { HandoffAssignment } from '../../handoff/assignment.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { HandoffEventSink } from '../../handoff/events.js'
import {
	type RunStatusResolver,
	type SingleHandoffDeps,
	executeSingleHandoff,
} from '../../handoff/single.js'
import { HandoffLockRejected } from '../../handoff/version.js'
import { GitWorktreeDriver } from '../../workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'
import { DEFAULT_TENANT, okExec, stubLogger, userActor } from './_fixtures.js'

function buildDeps(store: InMemorySessionStore, runStatus?: RunStatusResolver): SingleHandoffDeps {
	const driver = new GitWorktreeDriver({
		repoRoot: '/repo',
		logger: stubLogger(),
		execFile: async () => okExec(),
	})
	const workspaceRegistry = new WorkspaceBackendRegistry()
	workspaceRegistry.register(driver)

	const events: HandoffEventSink = {}

	return {
		store,
		workspaceRegistry,
		capacity: new DefaultCapacityValidator(store),
		events,
		...(runStatus !== undefined && { runStatus }),
	}
}

async function seedIdleSession(store: InMemorySessionStore) {
	const project = await store.createProject(
		{ tenantId: DEFAULT_TENANT, name: 'illegal' },
		DEFAULT_TENANT,
	)
	const session = await store.createSession(
		{ projectId: project.id, currentActor: userActor('usr_source') },
		DEFAULT_TENANT,
	)
	return { project, session }
}

function buildAssignment(
	sourceSessionId: Awaited<ReturnType<InMemorySessionStore['createSession']>>['id'],
	projectId: Awaited<ReturnType<InMemorySessionStore['createProject']>>['id'],
): HandoffAssignment {
	return {
		id: generateHandoffId(),
		mode: 'single',
		sourceSessionId,
		tenantId: DEFAULT_TENANT,
		projectId,
		sourceActor: userActor('usr_source'),
		recipientActor: userActor('usr_target'),
		expectedOwnerVersion: 0,
		createdAt: new Date('2026-04-17'),
	}
}

describe('Integration — illegal handoff transitions (§5.1)', () => {
	it('running Run → HandoffLockRejected { reason: active_run }', async () => {
		const store = new InMemorySessionStore()
		const { project, session } = await seedIdleSession(store)
		const deps = buildDeps(store, {
			async blockingRun() {
				return { reason: 'active_run' }
			},
		})
		const assignment = buildAssignment(session.id, project.id)

		try {
			await executeSingleHandoff(deps, assignment, DEFAULT_TENANT)
			expect.fail('expected HandoffLockRejected')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffLockRejected)
			expect((err as HandoffLockRejected).details.reason).toBe('active_run')
		}

		// Source never locked — still idle with original version.
		const reloaded = await store.getSession(session.id, DEFAULT_TENANT)
		expect(reloaded?.status).toBe('idle')
		expect(reloaded?.ownerVersion).toBe(0)
	})

	it('awaiting_hitl → HandoffLockRejected { reason: pending_hitl }', async () => {
		const store = new InMemorySessionStore()
		const { project, session } = await seedIdleSession(store)
		const deps = buildDeps(store, {
			async blockingRun() {
				return { reason: 'pending_hitl' }
			},
		})

		try {
			await executeSingleHandoff(deps, buildAssignment(session.id, project.id), DEFAULT_TENANT)
			expect.fail('expected HandoffLockRejected')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffLockRejected)
			expect((err as HandoffLockRejected).details.reason).toBe('pending_hitl')
		}
	})

	it('awaiting_hitl_resolution collapses into pending_hitl reason (timeout variant)', async () => {
		// §5.2 treats `awaiting_hitl_resolution` as the same non-terminal class
		// that forces the source into `awaiting_hitl` — the resolver surfaces
		// `pending_hitl` for both. This keeps the lock-rejection enum
		// conservative (no new reason variant for a sub-state).
		const store = new InMemorySessionStore()
		const { project, session } = await seedIdleSession(store)
		const deps = buildDeps(store, {
			async blockingRun() {
				return { reason: 'pending_hitl' }
			},
		})

		await expect(
			executeSingleHandoff(deps, buildAssignment(session.id, project.id), DEFAULT_TENANT),
		).rejects.toBeInstanceOf(HandoffLockRejected)
	})

	it('awaiting_subsession → HandoffLockRejected { reason: pending_subsession }', async () => {
		const store = new InMemorySessionStore()
		const { project, session } = await seedIdleSession(store)
		const deps = buildDeps(store, {
			async blockingRun() {
				return { reason: 'pending_subsession' }
			},
		})

		try {
			await executeSingleHandoff(deps, buildAssignment(session.id, project.id), DEFAULT_TENANT)
			expect.fail('expected HandoffLockRejected')
		} catch (err) {
			expect(err).toBeInstanceOf(HandoffLockRejected)
			expect((err as HandoffLockRejected).details.reason).toBe('pending_subsession')
		}
	})

	it('session status precondition: active-status session rejects before resolver fires', async () => {
		// When the session itself is already non-idle (e.g. `active`), the lock
		// rejection fires from the status check — no RunStatusResolver invoked.
		const store = new InMemorySessionStore()
		const { project, session } = await seedIdleSession(store)
		await store.updateSession({ ...session, status: 'active' }, DEFAULT_TENANT)

		const deps = buildDeps(store, {
			async blockingRun() {
				return null // resolver would allow, but status guard trips first
			},
		})

		await expect(
			executeSingleHandoff(deps, buildAssignment(session.id, project.id), DEFAULT_TENANT),
		).rejects.toBeInstanceOf(HandoffLockRejected)
	})
})
