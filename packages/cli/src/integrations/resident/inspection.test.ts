import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
	DiskResidentAgenda,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { writeResidentStepLog } from './__fixtures__/resident-step-log.js'
import { inspectCliResident } from './inspection.js'
import { type CliResident, residentsRootFor } from './storage.js'

const roots: string[] = []
afterEach(async () => {
	for (const root of roots) removeTempDir(root)
	roots.length = 0
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'resident-inspection-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const projectId = generateProjectId()
	const agentKey = 'reviewer'
	const slug = '-workspace'
	const agenda = new DiskResidentAgenda(residentsRootFor(root, slug), { tenantId, agentKey })
	const artifactsRoot = join(root, 'attempts')
	const resident: CliResident = {
		root,
		slug,
		tenantId,
		projectId,
		agentKey,
		agenda,
		artifactsRoot,
		cwd: root,
	}
	const pursuit = await agenda.add(
		await agenda.create('Read authorized documents.'),
		'Read only package.json.',
	)
	const claim = await agenda.execution(pursuit.id).claim(pursuit.state, Date.now())
	const current = async () => (await agenda.read())!
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	const identity = { version: 1, pursuitId: pursuit.id, claimId: claim.claimId!, sessionId, turnId }
	const startPath = join(artifactsRoot, claim.claimId!, 'start.json')
	const finishPath = join(artifactsRoot, claim.claimId!, 'finish.json')
	const budget = {
		ownTokens: 120,
		treeTokens: 300,
		inFlightRequests: 0,
		unsettledChildren: 0,
		unresolvedRequests: 0,
		poisoned: false,
	}
	const start = { ...identity, startedAt: 1000 }
	const finish = {
		...identity,
		finishedAt: 2000,
		cleanup: 'confirmed',
		error: null,
		stopReason: 'end_turn',
		decision: { kind: 'complete', summary: 'Package version checked.' },
		usage: { totalTokens: 120, cost: { totalCost: 0.02, unpricedTokens: 20 } },
		budget,
	}
	/** The step's own session log: the ledger the receipts are checked against. */
	const writeLog = (overrides: { projectId?: typeof projectId; settled?: boolean } = {}) =>
		writeResidentStepLog({
			home: root,
			slug,
			sessionId,
			turnId,
			projectId: overrides.projectId ?? projectId,
			tenantId,
			...(overrides.settled === false ? {} : { totalTokens: 120, budget }),
		})
	const save = async (path: string, value: unknown) => {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, JSON.stringify(value))
	}
	await save(startPath, start)
	await save(finishPath, finish)
	const logPath = await writeLog()
	const inspect = async () => inspectCliResident(resident, (await current()).revision)
	const settle = async () =>
		agenda
			.execution(pursuit.id)
			.settle(claim, { kind: 'complete', summary: 'Inspected completion.' }, Date.now())
	return {
		resident,
		claim,
		pursuit,
		identity,
		startPath,
		finishPath,
		logPath,
		writeLog,
		start,
		finish,
		save,
		current,
		inspect,
		settle,
	}
}

it('reads archived consumption through the step session log without changing files', async () => {
	const f = await fixture()
	await f.settle()
	await f.resident.agenda.archive(await f.current(), { pursuitIds: [f.pursuit.id] })
	const before = await readFile(f.finishPath, 'utf8')
	const result = await f.inspect()
	expect(result.inspection.recorded).toEqual({
		ownTokens: 120,
		treeTokens: 300,
		ownCostUsd: 0.02,
		unpricedOwnTokens: 20,
	})
	expect(result.inspection.historyComplete).toBe(true)
	expect(result.inspection.unknown.ownPriceAttempts).toBe(1)
	expect(result.inspection.archivedPursuits).toEqual([f.pursuit.id])
	expect(result.text).toContain('0 completions with recorded verification')
	expect(await readFile(f.finishPath, 'utf8')).toBe(before)
})

it('keeps abrupt-exit turn usage provisional when finish.json is missing', async () => {
	const f = await fixture()
	await unlink(f.finishPath)
	const { inspection } = await f.inspect()
	expect(inspection.recorded.ownTokens).toBe(120)
	expect(inspection.unknown).toEqual({
		ownUsageAttempts: 1,
		treeUsageAttempts: 1,
		ownPriceAttempts: 1,
	})
	expect(inspection.attempts[0]?.receipt).toMatchObject({
		usageFinal: false,
		cleanup: 'unknown',
		ownCostUsd: null,
		verification: 'unconfirmed',
	})
	expect(inspection.attempts[0]?.settlement).toBeNull()
})

it('manual reconciliation does not manufacture usage for an unexecuted admission', async () => {
	const f = await fixture()
	await unlink(f.startPath)
	await f.settle()
	const { inspection } = await f.inspect()
	expect(inspection.recorded.ownTokens).toBe(0)
	expect(inspection.unknown.ownUsageAttempts).toBe(1)
	expect(inspection.attempts[0]?.settlement?.outcome).toBe('complete')
	expect(inspection.attempts[0]?.receiptStatus).toBe('missing')
})

it('rejects foreign project, copied claim, mismatched usage and corrupt receipts', async () => {
	for (const mode of ['project', 'claim', 'usage', 'corrupt']) {
		const f = await fixture()
		if (mode === 'project') {
			await unlink(f.logPath)
			await f.writeLog({ projectId: generateProjectId() })
		}
		if (mode === 'claim') await f.save(f.finishPath, { ...f.finish, claimId: randomUUID() })
		if (mode === 'usage')
			await f.save(f.finishPath, { ...f.finish, usage: { ...f.finish.usage, totalTokens: 300 } })
		if (mode === 'corrupt') await writeFile(f.finishPath, '{')
		const { inspection } = await f.inspect()
		expect(inspection.attempts[0]?.receiptStatus).toBe('invalid')
		expect(inspection.recorded.ownTokens).toBe(0)
	}
})

it('refuses symlinked or oversized receipt bodies before interpreting them', async () => {
	const f = await fixture()
	const other = join(f.resident.root, 'other.json')
	await f.save(other, f.finish)
	await unlink(f.finishPath)
	await symlink(other, f.finishPath)
	expect((await f.inspect()).inspection.attempts[0]?.receiptStatus).toBe('invalid')
	await unlink(f.finishPath)
	await writeFile(f.finishPath, ' '.repeat(65_537))
	expect((await f.inspect()).inspection.attempts[0]?.receiptStatus).toBe('invalid')
})

it('counts only scope-matched recorded verification and never re-reads current sources', async () => {
	const f = await fixture()
	await f.settle()
	const verification = {
		answerSha256: 'a'.repeat(64),
		receipt: {
			scope: JSON.stringify({
				tenantId: f.resident.tenantId,
				projectId: f.resident.projectId,
				pursuitId: f.pursuit.id,
				claimId: f.claim.claimId,
				sessionId: f.identity.sessionId,
				turnId: f.identity.turnId,
				revision: f.claim.revision,
			}),
			turnId: f.identity.turnId,
			claims: { version: '1.0' },
			observations: [
				{ source: 'package.json', observedAt: 1500, bytes: 5, sha256: 'b'.repeat(64) },
			],
		},
	}
	const finish = {
		...f.finish,
		verificationPolicy: {
			version: 1,
			claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
		},
		verification,
	}
	await f.save(f.finishPath, finish)
	// No package.json exists: inspecting a historical receipt must not observe it again.
	expect((await f.inspect()).text).toContain('1 completion with recorded verification')
	await f.save(f.finishPath, {
		...finish,
		verification: { ...verification, receipt: { ...verification.receipt, scope: '{}' } },
	})
	expect((await f.inspect()).inspection.attempts[0]?.receiptStatus).toBe('invalid')
})

it('a missing completion receipt, unresolved provider call or uncertain cleanup cannot imply final usage', async () => {
	for (const patch of [
		{ usage: null },
		{ cleanup: 'unconfirmed' },
		{
			budget: {
				ownTokens: 120,
				treeTokens: 300,
				inFlightRequests: 0,
				unsettledChildren: 0,
				poisoned: false,
				unresolvedRequests: 1,
			},
		},
	]) {
		const f = await fixture()
		await f.save(f.finishPath, { ...f.finish, ...patch })
		const { inspection } = await f.inspect()
		expect(inspection.usageComplete).toBe(false)
		expect(inspection.recorded.ownTokens).toBe(120)
	}
})

it('reports an unsettled turn with only its receipt usage, never as final', async () => {
	const f = await fixture()
	await unlink(f.logPath)
	await f.writeLog({ settled: false })
	const { inspection } = await f.inspect()
	expect(inspection.attempts[0]?.receipt).toMatchObject({ ownTokens: 120, usageFinal: false })
	expect(inspection.usageComplete).toBe(false)
})

it('treats an attempt with no session log as missing, not as zero usage', async () => {
	const f = await fixture()
	await unlink(f.logPath)
	const { inspection } = await f.inspect()
	expect(inspection.attempts[0]?.receiptStatus).toBe('missing')
	expect(inspection.unknown.ownUsageAttempts).toBe(1)
})
