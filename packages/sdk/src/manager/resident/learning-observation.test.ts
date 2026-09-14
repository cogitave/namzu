import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateProjectId, generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import type { ResidentLearningObservation } from './learning-observation.js'
import {
	type ResidentLearningDiscoveryOptions,
	SqliteResidentLearningStore,
	runStoredResidentLearningFromObservations,
} from './learning-store.js'
import { hashResidentSkill } from './learning.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const target = {
	skillName: 'source-check',
	evaluatorRevision: 'muse-low/source-evaluator-v1',
	baselineRevision: 'none',
}
function observation(
	overrides: Partial<ResidentLearningObservation> = {},
): ResidentLearningObservation {
	return {
		...target,
		runId: randomUUID(),
		taskKey: 'task-a@input-hash',
		outcome: 'failed',
		usageComplete: true,
		evidence: {
			key: 'retained-run',
			source: 'host-source-check',
			reason: 'Wrong source was read.',
		},
		trace: 'Read old.txt; expected the value in current.txt.',
		...overrides,
	}
}
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-discovery-'))
	roots.push(root)
	const scope = {
		tenantId: generateTenantId(),
		projectId: generateProjectId(),
		agentKey: 'default',
	}
	const storage = {
		databasePath: join(root, 'learning.sqlite'),
		artifactsPath: join(root, 'artifacts'),
		scope,
	}
	const store = new SqliteResidentLearningStore(storage)
	const agenda = new DiskResidentAgenda(join(root, 'agenda'), scope)
	await agenda.create('Use retained observations to improve source selection.')
	const generate = vi.fn(async () => {
		throw new Error('Generator interrupted after admission.')
	})
	const evaluate = vi.fn(async () => {
		throw new Error('Unexpected evaluation.')
	})
	const options: ResidentLearningDiscoveryOptions = {
		agenda,
		evaluators: [target],
		signal: new AbortController().signal,
		resources: { unit: 'tokens', maxUnits: 100 },
		generate,
		evaluate,
	}
	return { root, storage, store, agenda, options, generate, evaluate }
}

describe('resident learning observations and admission', () => {
	it('retains immutable host evidence, UUID aliases and ordered pages across reopen', async () => {
		const f = await fixture()
		const a = observation()
		await f.store.observe(a)
		await f.store.observe({ ...a, runId: a.runId.toUpperCase() })
		await expect(f.store.observe({ ...a, outcome: 'passed' })).rejects.toThrow('different content')
		await f.store.observe(observation({ taskKey: 'task-b' }))
		const bytes = readFileSync(f.storage.databasePath)
		const reader = new SqliteResidentLearningStore({ ...f.storage, readOnly: true })
		const first = (await reader.observations({ limit: 1 }))[0]
		if (!first) throw new Error('Missing observation.')
		expect(first).toMatchObject({ ...a, attemptedCycleId: null })
		expect((await reader.observations({ after: first.ordinal })).map((o) => o.taskKey)).toEqual([
			'task-b',
		])
		expect(readFileSync(f.storage.databasePath)).toEqual(bytes)
		await expect(reader.observe(observation())).rejects.toThrow('read-only')
	})
	it('selects only settled failed tasks for the exact current evaluator and baseline', async () => {
		const f = await fixture()
		for (const overrides of [
			{ outcome: 'execution-error' },
			{ outcome: 'unresolved' },
			{ outcome: 'passed' },
			{ usageComplete: false },
			{ evaluatorRevision: 'other-model' },
			{ baselineRevision: 'a'.repeat(64) },
		] as Partial<ResidentLearningObservation>[])
			await f.store.observe(observation(overrides))
		expect(await f.store.selectObservation([target])).toBeNull()
		const failed = observation({ taskKey: 'eligible' })
		await f.store.observe(failed)
		await f.store.observe(observation({ taskKey: 'later' }))
		expect(await f.store.selectObservation([target])).toMatchObject(failed)
		await expect(f.store.selectObservation([target, target])).rejects.toThrow(
			'one current evaluator',
		)
	})
	it('does not use an older failure after the same task passes; a later failure remains observable', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		await f.store.observe(observation({ outcome: 'passed' }))
		expect(await f.store.selectObservation([target])).toBeNull()
		const later = observation()
		await f.store.observe(later)
		expect(await f.store.selectObservation([target])).toMatchObject({ runId: later.runId })
	})
	it('claims once before generation, retains interruption, and prevents task retries after reopen', async () => {
		const f = await fixture()
		const input = observation()
		await f.store.observe(input)
		const result = await runStoredResidentLearningFromObservations(f.store, f.options)
		if (!result.cycle) throw new Error('Missing admitted cycle.')
		expect(result.cycle).toMatchObject({
			status: 'failed',
			reason: expect.stringContaining('interrupted'),
		})
		expect(f.generate).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				failure: { evidence: input.evidence, trace: input.trace },
				skillName: input.skillName,
				baseline: null,
			}),
		)
		expect(f.evaluate).not.toHaveBeenCalled()
		const reopened = new SqliteResidentLearningStore(f.storage)
		await reopened.observe(observation()) // a different run of the same task is not new learning work
		const records = await reopened.observations()
		expect(records.every((r) => r.attemptedCycleId === result.cycle?.cycleId)).toBe(true)
		expect(await runStoredResidentLearningFromObservations(reopened, f.options)).toEqual({
			observation: null,
			cycle: null,
		})
		expect(f.generate).toHaveBeenCalledTimes(1)
		const events = await reopened.events(result.cycle.cycleId)
		expect(events[0]?.data.observation).toEqual({ ordinal: records[0]?.ordinal })
	})
	it('two concurrent hosts cannot both execute the same task', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		const second = new SqliteResidentLearningStore(f.storage)
		const results = await Promise.all([
			runStoredResidentLearningFromObservations(f.store, f.options),
			runStoredResidentLearningFromObservations(second, f.options),
		])
		expect(f.generate).toHaveBeenCalledTimes(1)
		expect((await f.store.observations())[0]?.attemptedCycleId).not.toBeNull()
		expect(results.every((r) => r.cycle?.status === 'failed' || r.cycle === null)).toBe(true)
	})
	it('rechecks a pass arriving between selection and the start transaction', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		const select = f.store.selectObservation.bind(f.store)
		vi.spyOn(f.store, 'selectObservation').mockImplementation(async (targets) => {
			const selected = await select(targets)
			await f.store.observe(observation({ outcome: 'passed' }))
			return selected
		})
		const result = await runStoredResidentLearningFromObservations(f.store, f.options)
		expect(result.cycle?.status).toBe('failed')
		expect(f.generate).not.toHaveBeenCalled()
		expect((await f.store.observations()).every((o) => o.attemptedCycleId === null)).toBe(true)
		expect(await f.store.list()).toEqual([]) // rolled back with the failed claim
	})
	it('binds admission to the baseline actually read by the cycle', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		const read = f.agenda.read.bind(f.agenda)
		let calls = 0
		vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
			const state = await read()
			if (++calls === 1) return state
			if (!state) throw new Error('Missing agenda.')
			const skill = { name: target.skillName, description: 'Changed', body: 'New baseline' }
			const hash = hashResidentSkill(skill)
			const evidence = observation().evidence
			return {
				...state,
				learning: {
					revision: 1,
					preferences: [],
					lastChange: evidence,
					skills: [
						{
							...skill,
							hash,
							evidence,
							verification: {
								baselineHash: 'none',
								candidateHash: hash,
								evidenceDigest: 'a'.repeat(64),
								verificationTasks: 5,
								confirmationTasks: 5,
							},
						},
					],
				},
			}
		})
		const result = await runStoredResidentLearningFromObservations(f.store, f.options)
		expect(result.cycle?.reason).toContain('current learning baseline')
		expect(f.generate).not.toHaveBeenCalled()
		expect((await f.store.observations())[0]?.attemptedCycleId).toBeNull()
	})
	it('isolates observation selection and inspection by tenant, project and resident', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		for (const scope of [
			{ ...f.storage.scope, tenantId: generateTenantId() },
			{ ...f.storage.scope, projectId: generateProjectId() },
			{ ...f.storage.scope, agentKey: 'other' },
		]) {
			const other = new SqliteResidentLearningStore({ ...f.storage, scope })
			expect(await other.observations()).toEqual([])
			expect(await other.selectObservation([target])).toBeNull()
		}
	})
	it('reads the previous journal without mutation and upgrades on an observation write', async () => {
		const f = await fixture()
		await f.store.observe(observation())
		const db = new DatabaseSync(f.storage.databasePath)
		db.exec('DROP TABLE observation_attempts; DROP TABLE observations; PRAGMA user_version=1;')
		db.close()
		const before = readFileSync(f.storage.databasePath)
		const reader = new SqliteResidentLearningStore({ ...f.storage, readOnly: true })
		expect(await reader.observations()).toEqual([])
		expect(await reader.selectObservation([target])).toBeNull()
		expect(readFileSync(f.storage.databasePath)).toEqual(before)
		await f.store.observe(observation())
		expect(await reader.observations()).toHaveLength(1)
	})
	it('does not invoke generation with no eligible work or cancelled authorization', async () => {
		const f = await fixture()
		await f.store.observe(observation({ outcome: 'execution-error' }))
		expect(await runStoredResidentLearningFromObservations(f.store, f.options)).toEqual({
			observation: null,
			cycle: null,
		})
		await expect(
			runStoredResidentLearningFromObservations(f.store, {
				...f.options,
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow()
		expect(f.generate).not.toHaveBeenCalled()
	})
})
