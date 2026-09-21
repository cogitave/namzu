import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { generateProjectId, generateTenantId } from '../../utils/id.js'
import { SqliteResidentLearningStore } from './learning-store.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'namzu-learning-process-'))
	roots.push(root)
	const options = {
		databasePath: join(root, 'learning.sqlite'),
		artifactsPath: join(root, 'artifacts'),
		scope: {
			tenantId: generateTenantId(),
			projectId: generateProjectId(),
			agentKey: 'default',
		},
	}
	return {
		options,
		store: new SqliteResidentLearningStore(options),
		cycleId: randomUUID(),
	}
}

function child(script: string) {
	return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
		const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		process.stdout.on('data', (chunk) => {
			output += chunk
		})
		process.stderr.on('data', (chunk) => {
			output += chunk
		})
		process.on('error', reject)
		process.on('exit', (code) => resolve({ code, output }))
	})
}

it('two processes competing for one sequence cannot overwrite each other', async () => {
	const f = fixture()
	await f.store.append({
		cycleId: f.cycleId,
		sequence: 1,
		kind: 'started',
		data: { tenantId: f.options.scope.tenantId, agentKey: 'default' },
	})
	const module = new URL('../../../dist/manager/resident/learning-store.js', import.meta.url).href
	const contenders = await Promise.all(
		['first', 'second'].map((marker) =>
			child(`
import { SqliteResidentLearningStore } from ${JSON.stringify(module)};
const store = new SqliteResidentLearningStore(${JSON.stringify(f.options)});
try { await store.append({cycleId:${JSON.stringify(f.cycleId)},sequence:2,kind:'stage-started',stage:'generate',data:{marker:${JSON.stringify(marker)}}});console.log('committed'); }
catch(error) {console.error(error.message);process.exitCode=3;}
`),
		),
	)
	expect(contenders.map((c) => c.code).sort(), JSON.stringify(contenders)).toEqual([0, 3])
	expect(contenders.find((c) => c.code === 3)?.output).toContain('different content')
	const events = await f.store.events(f.cycleId)
	expect(events).toHaveLength(2)
	expect((await f.store.get(f.cycleId))?.sequence).toBe(2)
})

it('a killed SQLite writer leaves no partial event or falsely advanced summary', async () => {
	const f = fixture()
	await f.store.append({
		cycleId: f.cycleId,
		sequence: 1,
		kind: 'started',
		data: { tenantId: f.options.scope.tenantId, agentKey: 'default' },
	})
	await child(`
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(${JSON.stringify(f.options.databasePath)});
db.exec('PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
db.prepare('INSERT INTO events VALUES (?,2,?)').run(${JSON.stringify(f.cycleId)},'uncommitted');
db.prepare('UPDATE cycles SET sequence=2,status=? WHERE id=?').run('activated',${JSON.stringify(f.cycleId)});
process.kill(process.pid,'SIGKILL');
`)
	expect(await f.store.get(f.cycleId)).toMatchObject({
		sequence: 1,
		status: 'running',
		result: null,
	})
	expect(await f.store.events(f.cycleId)).toHaveLength(1)
	await f.store.append({
		cycleId: f.cycleId,
		sequence: 2,
		kind: 'stage-started',
		stage: 'generate',
		data: {},
	})
	expect((await f.store.get(f.cycleId))?.sequence).toBe(2)
})

it('separate processes claim a learning task once and reopening does not replay an unfinished experiment', async () => {
	const f = fixture()
	const observation = {
		sessionId: randomUUID(),
		turnId: randomUUID(),
		skillName: 'source-check',
		evaluatorRevision: 'fixture-v1',
		baselineRevision: 'none',
		taskKey: 'same-input',
		outcome: 'failed' as const,
		usageComplete: true,
		evidence: { key: 'actual-run', source: 'fixture', reason: 'Source differed.' },
		trace: 'Expected A, observed B.',
	}
	await f.store.observe(observation)
	const selected = await f.store.selectObservation([observation])
	if (!selected) throw new Error('Missing selected observation.')
	const module = new URL('../../../dist/manager/resident/learning-store.js', import.meta.url).href
	const events = [0, 1].map(() => ({
		cycleId: randomUUID(),
		sequence: 1,
		kind: 'started' as const,
		data: {
			tenantId: f.options.scope.tenantId,
			agentKey: 'default',
			skillName: observation.skillName,
			baselineRevision: 'none',
			failure: { evidence: observation.evidence, trace: observation.trace },
			observation: { ordinal: selected.ordinal },
		},
	}))
	const contenders = await Promise.all(
		events.map((event) =>
			child(`
import { SqliteResidentLearningStore } from ${JSON.stringify(module)};
const store = new SqliteResidentLearningStore(${JSON.stringify(f.options)});
try {await store.append(${JSON.stringify(event)});console.log('claimed');}
catch(error){console.error(error.message);process.exitCode=3;}
`),
		),
	)
	expect(contenders.map((r) => r.code).sort(), JSON.stringify(contenders)).toEqual([0, 3])
	const reopened = new SqliteResidentLearningStore(f.options)
	expect(await reopened.list()).toHaveLength(1)
	expect((await reopened.list())[0]).toMatchObject({ status: 'running', result: null })
	expect(await reopened.selectObservation([observation])).toBeNull()
	await reopened.observe({ ...observation, turnId: randomUUID() })
	expect(await reopened.selectObservation([observation])).toBeNull()
})
