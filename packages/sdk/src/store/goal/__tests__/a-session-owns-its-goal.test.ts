import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { TenantIsolationError } from '../../../session/errors.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import type { SessionStore } from '../../../types/session/store.js'
import {
	asGoalId,
	asSessionId,
	generateProjectId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { DiskSessionStore } from '../../session/disk.js'
import { InMemorySessionStore } from '../../session/memory.js'
import {
	type CreateSessionGoalParams,
	DiskSessionGoalStore,
	GoalExistsError,
	GoalRoundLimitError,
	GoalSessionNotFoundError,
	GoalTransitionError,
	InMemorySessionGoalStore,
	type SessionGoalStore,
	StaleGoalError,
} from '../index.js'

const publicCreateShape = {
	sessionId: asSessionId('ses_goal_surface'),
	objective: 'compile-time surface',
	maxGoalRounds: 1,
} satisfies CreateSessionGoalParams
void publicCreateShape

const roots: string[] = []

afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function seedSession(store: SessionStore, tenantId: TenantId): Promise<SessionId> {
	const project = await store.createProject(
		{ tenantId, name: 'goal test', rootPath: undefined },
		tenantId,
	)
	return (
		await store.createSession(
			{ projectId: project.id, topicId: generateTopicId(), currentActor: null },
			tenantId,
		)
	).id
}

interface Fixture {
	readonly goals: SessionGoalStore
	readonly sessions: SessionStore
	readonly tenantId: TenantId
	readonly sessionId: SessionId
}

async function memoryFixture(): Promise<Fixture> {
	const sessions = new InMemorySessionStore()
	const tenantId = generateTenantId()
	const sessionId = await seedSession(sessions, tenantId)
	let id = 0
	return {
		sessions,
		tenantId,
		sessionId,
		goals: new InMemorySessionGoalStore(
			{ sessions },
			() => 1_000 + id,
			() => asGoalId(`goal_memory_${++id}`),
		),
	}
}

async function diskFixture(): Promise<Fixture & { readonly root: string }> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-session-goal-'))
	roots.push(root)
	const sessions = new DiskSessionStore({ rootDir: root })
	const tenantId = generateTenantId()
	const sessionId = await seedSession(sessions, tenantId)
	let id = 0
	return {
		root,
		sessions,
		tenantId,
		sessionId,
		goals: new DiskSessionGoalStore(
			{ rootDir: root, sessions },
			() => 2_000 + id,
			() => asGoalId(`goal_disk_${++id}`),
		),
	}
}

const implementations: readonly [string, () => Promise<Fixture>][] = [
	['in-memory', memoryFixture],
	['disk', diskFixture],
]

describe.each(implementations)('%s session goal store', (_name, fixture) => {
	it('walks the direct-human lifecycle under exact revisions', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const created = await goals.createGoal(
			{ sessionId, objective: '  finish the release  ' },
			tenantId,
		)
		expect(created).toMatchObject({
			sessionId,
			tenantId,
			revision: 1,
			objective: 'finish the release',
			phase: 'active',
			maxGoalRounds: 256,
			roundsAdmitted: 0,
		})
		expect(Object.keys(created).sort()).toEqual([
			'createdAt',
			'id',
			'maxGoalRounds',
			'objective',
			'phase',
			'revision',
			'roundsAdmitted',
			'sessionId',
			'tenantId',
			'updatedAt',
		])
		// @ts-expect-error round accounting arrives with the admission driver, not before it
		void created.roundsStarted

		const edited = await goals.editGoal(
			sessionId,
			tenantId,
			{ id: created.id, revision: created.revision },
			{ objective: 'ship after verification' },
		)
		const paused = await goals.pauseGoal(sessionId, tenantId, {
			id: edited.id,
			revision: edited.revision,
		})
		const resumed = await goals.resumeGoal(sessionId, tenantId, {
			id: paused.id,
			revision: paused.revision,
		})
		const blocked = await goals.blockGoal(
			sessionId,
			tenantId,
			{ id: resumed.id, revision: resumed.revision },
			{
				code: 'needs-owner',
				message: '  Owner must choose the release channel.  ',
			},
		)

		expect(blocked).toMatchObject({
			revision: 5,
			phase: 'blocked',
			blockedReason: {
				code: 'needs-owner',
				message: 'Owner must choose the release channel.',
			},
		})
		expect(await goals.getGoal(sessionId, tenantId)).toEqual(blocked)

		const completed = await goals.completeGoal(sessionId, tenantId, {
			id: blocked.id,
			revision: blocked.revision,
		})
		expect(completed).toMatchObject({ revision: 6, phase: 'complete' })
		expect(completed).not.toHaveProperty('blockedReason')
		expect(await goals.getGoal(sessionId, tenantId)).toEqual(completed)
	})

	it('keeps clear as a tombstone and gives a replacement a fresh identity', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const first = await goals.createGoal({ sessionId, objective: 'first' }, tenantId)
		const completed = await goals.completeGoal(sessionId, tenantId, {
			id: first.id,
			revision: first.revision,
		})
		const second = await goals.createGoal({ sessionId, objective: 'second' }, tenantId)
		expect(second.id).not.toBe(completed.id)
		expect(second.revision).toBe(1)

		await goals.clearGoal(sessionId, tenantId, { id: second.id, revision: second.revision })
		expect(await goals.getGoal(sessionId, tenantId)).toBeNull()

		const third = await goals.createGoal({ sessionId, objective: 'third' }, tenantId)
		expect(third.id).not.toBe(second.id)
		expect(third.revision).toBe(1)
	})

	it('refuses stale and invalid transitions without changing the winner', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const created = await goals.createGoal({ sessionId, objective: 'one writer' }, tenantId)
		const paused = await goals.pauseGoal(sessionId, tenantId, {
			id: created.id,
			revision: created.revision,
		})

		await expect(
			goals.editGoal(
				sessionId,
				tenantId,
				{ id: created.id, revision: created.revision },
				{ objective: 'stale' },
			),
		).rejects.toBeInstanceOf(StaleGoalError)
		await expect(
			goals.pauseGoal(sessionId, tenantId, {
				id: paused.id,
				revision: paused.revision,
			}),
		).rejects.toBeInstanceOf(GoalTransitionError)
		expect(await goals.getGoal(sessionId, tenantId)).toEqual(paused)
	})

	it('admits an exact round before work and durably blocks at the finite limit', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const created = await goals.createGoal(
			{ sessionId, objective: 'finish exactly once', maxGoalRounds: 1 },
			tenantId,
		)

		const authority = await goals.admitRound(sessionId, tenantId, created)
		expect(authority).toEqual({
			id: created.id,
			revision: 2,
			sessionId,
			tenantId,
			objective: 'finish exactly once',
			round: 1,
			maxGoalRounds: 1,
		})
		expect(await goals.getGoal(sessionId, tenantId)).toMatchObject({
			revision: 2,
			roundsAdmitted: 1,
			phase: 'active',
		})

		const exhausted = goals.admitRound(sessionId, tenantId, authority)
		await expect(exhausted).rejects.toBeInstanceOf(GoalRoundLimitError)
		await expect(exhausted).rejects.toMatchObject({
			name: 'GoalRoundLimitError',
			goal: {
				revision: 3,
				phase: 'blocked',
				roundsAdmitted: 1,
				blockedReason: {
					code: 'round-limit',
					message: 'Reached the 1-round limit.',
				},
			},
		})
		expect(await goals.getGoal(sessionId, tenantId)).toMatchObject({
			revision: 3,
			phase: 'blocked',
			roundsAdmitted: 1,
		})
	})

	it('admits only one caller against the same exact revision', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const created = await goals.createGoal({ sessionId, objective: 'one admission' }, tenantId)
		const outcomes = await Promise.allSettled([
			goals.admitRound(sessionId, tenantId, created),
			goals.admitRound(sessionId, tenantId, created),
		])

		expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const loser = outcomes.find((result) => result.status === 'rejected')
		expect(loser?.status === 'rejected' ? loser.reason : null).toBeInstanceOf(StaleGoalError)
		expect(await goals.getGoal(sessionId, tenantId)).toMatchObject({
			revision: 2,
			roundsAdmitted: 1,
		})
	})

	it('allows only one concurrent creator', async () => {
		const { goals, sessionId, tenantId } = await fixture()
		const outcomes = await Promise.allSettled([
			goals.createGoal({ sessionId, objective: 'alpha' }, tenantId),
			goals.createGoal({ sessionId, objective: 'beta' }, tenantId),
		])

		expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		const rejected = outcomes.find((result) => result.status === 'rejected')
		expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(GoalExistsError)
	})

	it('validates bounded human fields before committing them', async () => {
		const { goals, sessionId, tenantId } = await fixture()

		await expect(
			goals.createGoal({ sessionId, objective: '   ' }, tenantId),
		).rejects.toBeInstanceOf(TypeError)
		await expect(
			goals.createGoal({ sessionId, objective: 'x'.repeat(4_001) }, tenantId),
		).rejects.toBeInstanceOf(TypeError)
		await expect(
			goals.createGoal({ sessionId, objective: 'valid', maxGoalRounds: 0 }, tenantId),
		).rejects.toBeInstanceOf(TypeError)
		expect(await goals.getGoal(sessionId, tenantId)).toBeNull()

		const created = await goals.createGoal({ sessionId, objective: 'valid' }, tenantId)
		await expect(
			goals.blockGoal(
				sessionId,
				tenantId,
				{ id: created.id, revision: created.revision },
				{ code: 'Not_Kebab', message: 'explanation' },
			),
		).rejects.toBeInstanceOf(TypeError)
		expect(await goals.getGoal(sessionId, tenantId)).toEqual(created)
	})
})

it('migrates a schema-v1 goal to honest zero-admission accounting', async () => {
	const fixture = await diskFixture()
	const goalId = asGoalId('goal_legacy_v1')
	const legacyPath = join(fixture.root, 'goals', `${fixture.sessionId}.json`)
	await mkdir(join(fixture.root, 'goals'), { recursive: true })
	await writeFile(
		legacyPath,
		`${JSON.stringify({
			sessionId: fixture.sessionId,
			tenantId: fixture.tenantId,
			storageRevision: 1,
			goal: {
				id: goalId,
				sessionId: fixture.sessionId,
				tenantId: fixture.tenantId,
				revision: 1,
				objective: 'legacy objective',
				phase: 'active',
				createdAt: 100,
				updatedAt: 100,
			},
			updatedAt: 100,
		})}\n`,
	)

	const migrated = await fixture.goals.getGoal(fixture.sessionId, fixture.tenantId)
	expect(migrated).toMatchObject({
		id: goalId,
		maxGoalRounds: 256,
		roundsAdmitted: 0,
	})
	const admitted = await fixture.goals.admitRound(fixture.sessionId, fixture.tenantId, migrated!)
	expect(admitted).toMatchObject({ revision: 2, round: 1, maxGoalRounds: 256 })
})

describe('session ownership is checked before goal storage', () => {
	it('refuses a missing or other-tenant session without publishing a goal record', async () => {
		const fixture = await diskFixture()
		const otherTenant = generateTenantId()
		const missing = asSessionId(`ses_missing_${generateProjectId()}`)

		await expect(
			fixture.goals.createGoal(
				{ sessionId: fixture.sessionId, objective: 'tenant squat' },
				otherTenant,
			),
		).rejects.toBeInstanceOf(TenantIsolationError)
		await expect(
			fixture.goals.createGoal({ sessionId: missing, objective: 'phantom' }, fixture.tenantId),
		).rejects.toBeInstanceOf(GoalSessionNotFoundError)

		await expect(stat(join(fixture.root, 'goals'))).rejects.toMatchObject({
			code: 'ENOENT',
		})
		const ownerGoal = await fixture.goals.createGoal(
			{ sessionId: fixture.sessionId, objective: 'owner still wins' },
			fixture.tenantId,
		)
		expect(ownerGoal.objective).toBe('owner still wins')
	})
})
