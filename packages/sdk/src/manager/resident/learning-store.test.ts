import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { generateProjectId, generateTenantId } from '../../utils/id.js'
import type { ResidentLearningCycleEvent, ResidentLearningCycleResult } from './learning-cycle.js'
import { SqliteResidentLearningStore } from './learning-store.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-learning-db-'))
	roots.push(root)
	const options = {
		databasePath: join(root, 'state', 'learning.sqlite'),
		artifactsPath: join(root, 'learning', 'artifacts'),
		scope: {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			agentKey: 'default',
		},
	}
	const store = new SqliteResidentLearningStore(options)
	const cycleId = randomUUID()
	const start: ResidentLearningCycleEvent = {
		cycleId,
		sequence: 1,
		kind: 'started',
		data: {
			tenantId: options.scope.tenantId,
			agentKey: 'default',
			skillName: 'inspect',
			failure: { trace: 'Original failed observation.' },
		},
	}
	return { root, options, store, cycleId, start }
}

const result = (cycleId: string, tokens = 0): ResidentLearningCycleResult => ({
	cycleId,
	status: 'failed',
	reason: 'Evaluator interrupted.',
	consumption: {
		tokens,
		costUsd: 0,
		receipts: tokens ? 1 : 0,
		unknownTokens: 0,
		unknownCosts: tokens ? 1 : 0,
		unfinishedStages: 1,
	},
	auditComplete: true,
})

describe('SQLite resident learning journal', () => {
	it('commits journal and query projection together, preserves failed usage and reopens read-only', async () => {
		const f = fixture()
		await f.store.append(f.start)
		await f.store.append({
			cycleId: f.cycleId,
			sequence: 2,
			kind: 'usage',
			data: { receipt: { runId: randomUUID(), tokens: 7, costUsd: null } },
		})
		expect(await f.store.get(f.cycleId)).toMatchObject({
			status: 'running',
			result: null,
			recordedUsage: { tokens: 7, receipts: 1, unknownCosts: 1 },
		})
		const terminal: ResidentLearningCycleEvent = {
			cycleId: f.cycleId,
			sequence: 3,
			kind: 'finished',
			data: { result: result(f.cycleId, 7) },
		}
		await f.store.append(terminal)
		const before = readFileSync(f.options.databasePath)
		const reader = new SqliteResidentLearningStore({
			...f.options,
			readOnly: true,
		})
		expect((await reader.list())[0]).toMatchObject({
			cycleId: f.cycleId,
			status: 'failed',
			sequence: 3,
			result: result(f.cycleId, 7),
		})
		expect(await reader.events(f.cycleId, { limit: 1 })).toEqual([f.start])
		expect(await reader.events(f.cycleId, { after: 2 })).toEqual([terminal])
		expect(readFileSync(f.options.databasePath)).toEqual(before)
		expect(readdirSync(join(f.root, 'state'))).toEqual(['learning.sqlite'])
		await expect(reader.append(f.start)).rejects.toThrow('read-only')
	})

	it('inspection of an absent database never creates state', async () => {
		const f = fixture()
		const reader = new SqliteResidentLearningStore({
			...f.options,
			readOnly: true,
		})
		await expect(reader.list()).rejects.toThrow()
		expect(existsSync(join(f.root, 'state'))).toBe(false)
	})

	it('refuses duplicate receipt aliases and a fabricated final total atomically', async () => {
		const f = fixture()
		await f.store.append(f.start)
		const runId = randomUUID()
		await f.store.append({
			cycleId: f.cycleId,
			sequence: 2,
			kind: 'usage',
			data: { receipt: { runId, tokens: 7, costUsd: null } },
		})
		await expect(
			f.store.append({
				cycleId: f.cycleId,
				sequence: 3,
				kind: 'usage',
				data: {
					receipt: { runId: runId.toUpperCase(), tokens: 7, costUsd: null },
				},
			}),
		).rejects.toThrow()
		await expect(
			f.store.append({
				cycleId: f.cycleId,
				sequence: 3,
				kind: 'finished',
				data: { result: result(f.cycleId, 9) },
			}),
		).rejects.toThrow('differs')
		expect(await f.store.get(f.cycleId)).toMatchObject({
			sequence: 2,
			result: null,
			recordedUsage: { tokens: 7, receipts: 1 },
		})
	})

	it('retains exact event retry without advancing the sequence and rejects divergent retries', async () => {
		const f = fixture()
		await f.store.append(f.start)
		await f.store.append({ ...f.start, cycleId: f.cycleId.toUpperCase() })
		await expect(
			f.store.append({
				...f.start,
				data: { ...f.start.data, skillName: 'other' },
			}),
		).rejects.toThrow('different content')
		await expect(
			f.store.append({ ...f.start, sequence: 3, kind: 'stage-started' }),
		).rejects.toThrow('gap')
		expect((await f.store.get(f.cycleId))?.sequence).toBe(1)
	})

	it('refuses an append after a terminal result while retaining the original record', async () => {
		const f = fixture()
		await f.store.append(f.start)
		await f.store.append({
			cycleId: f.cycleId,
			sequence: 2,
			kind: 'finished',
			data: { result: result(f.cycleId) },
		})
		await expect(
			f.store.append({ ...f.start, sequence: 3, kind: 'stage-started' }),
		).rejects.toThrow('finished')
	})

	it.each(['tenantId', 'projectId', 'agentKey'] as const)(
		'isolates %s in listing, direct reads and artifacts',
		async (field) => {
			const f = fixture()
			await f.store.append(f.start)
			await f.store.putArtifact(f.cycleId, 'failure', {
				private: 'owned evidence',
			})
			const other = new SqliteResidentLearningStore({
				...f.options,
				scope: {
					...f.options.scope,
					[field]: field === 'agentKey' ? 'other' : randomUUID(),
				},
			})
			expect(await other.list()).toEqual([])
			await expect(other.get(f.cycleId)).rejects.toThrow('does not belong')
			await expect(other.readArtifact(f.cycleId, 'failure')).rejects.toThrow('does not belong')
			await expect(other.append(f.start)).rejects.toThrow('does not belong')
		},
	)

	it('requires retained same-scope ancestry and preserves the parent link', async () => {
		const f = fixture()
		await f.store.append(f.start)
		const child = randomUUID()
		await f.store.append({
			...f.start,
			cycleId: child,
			data: { ...f.start.data, parentCycleId: f.cycleId },
		})
		expect((await f.store.get(child))?.parentCycleId).toBe(f.cycleId)
		await expect(
			f.store.append({
				...f.start,
				cycleId: randomUUID(),
				data: { ...f.start.data, parentCycleId: randomUUID() },
			}),
		).rejects.toThrow('not retained')
		expect(await f.store.list({ before: (await f.store.get(child))?.ordinal })).toHaveLength(1)
	})

	it('publishes hash-checked immutable artifacts once and refuses substitution or damaged content', async () => {
		const f = fixture()
		await f.store.append(f.start)
		const body = {
			trials: [{ output: 'exact original source', passed: false }],
		}
		const artifact = await f.store.putArtifact(f.cycleId, 'verification', body)
		expect(await f.store.putArtifact(f.cycleId, 'verification', body)).toEqual(artifact)
		expect(await f.store.readArtifact(f.cycleId, 'verification')).toEqual(body)
		await expect(f.store.putArtifact(f.cycleId, 'verification', { trials: [] })).rejects.toThrow(
			'different content',
		)
		expect(await f.store.artifacts(f.cycleId)).toEqual([artifact])
		const path = join(f.options.artifactsPath, `${artifact.hash}.json`)
		writeFileSync(path, 'x'.repeat(artifact.bytes))
		await expect(f.store.readArtifact(f.cycleId, 'verification')).rejects.toThrow('hash mismatch')
	})

	it('keeps ambiguous activation visible after reopening without claiming completion or replaying', async () => {
		const f = fixture()
		await f.store.append(f.start)
		await f.store.append({
			cycleId: f.cycleId,
			sequence: 2,
			kind: 'activation-requested',
			data: {},
		})
		const reopened = new SqliteResidentLearningStore({
			...f.options,
			readOnly: true,
		})
		expect(await reopened.get(f.cycleId)).toMatchObject({
			status: 'activation-pending',
			result: null,
		})
	})

	it('records a cancelled preflight without fabricating a successful start', async () => {
		const f = fixture()
		await f.store.append({
			cycleId: f.cycleId,
			sequence: 1,
			kind: 'finished',
			data: { result: { ...result(f.cycleId), status: 'cancelled' } },
		})
		expect((await f.store.get(f.cycleId))?.status).toBe('cancelled')
	})

	it('refuses unknown schemas and never repairs or overwrites them during inspection', async () => {
		const f = fixture()
		await f.store.append(f.start)
		const db = new DatabaseSync(f.options.databasePath)
		db.exec('PRAGMA user_version = 99')
		db.close()
		const before = readFileSync(f.options.databasePath)
		await expect(
			new SqliteResidentLearningStore({ ...f.options, readOnly: true }).list(),
		).rejects.toThrow('version 99')
		expect(readFileSync(f.options.databasePath)).toEqual(before)
	})
})
