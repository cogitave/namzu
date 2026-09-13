// Storage and bounded inspection benchmark. Synthetic receipts and scheduler timestamps.
// Performance uses elapsed wall time; this is not the two-hour lifecycle soak.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
	DiskResidentAgenda,
	generateTenantId,
	inspectResidentConsumption,
} from '../../packages/sdk/dist/index.js'

const root = await mkdtemp(join(tmpdir(), 'namzu-lifetime-scale-'))
const files = ['activity', 'consumption', 'agenda']
const hashes = async () =>
	Object.fromEntries(
		await Promise.all(
			files.map(async (name) => [
				name,
				createHash('sha256')
					.update(
						await readFile(
							new URL(`../../packages/sdk/dist/manager/resident/${name}.js`, import.meta.url),
						),
					)
					.digest('hex'),
			]),
		),
	)
const result = {
	root,
	scripted: true,
	startedAt: Date.now(),
	buildBefore: await hashes(),
	rows: [],
}
console.log(JSON.stringify({ root }))
try {
	for (const steps of [128, 512, 1024]) {
		const scope = { tenantId: generateTenantId(), agentKey: `scale-${steps}` }
		const agenda = new DiskResidentAgenda(root, scope)
		let pursuit = await agenda.add(
			await agenda.create('Local accounting scale fixture.'),
			'Count bounded local fixture work.',
		)
		const execution = agenda.execution(pursuit.id)
		const started = performance.now()
		const schedulerEpoch = Date.now()
		for (let step = 0; step < steps; step++) {
			const now = schedulerEpoch + step * 2
			const claim = await execution.claim(pursuit.state, now)
			await execution.settle(
				claim,
				step === steps - 1
					? { kind: 'complete', summary: 'Fixture complete.' }
					: { kind: 'wait', summary: `Fixture step ${step + 1}.`, wakeAt: now + 1 },
				now,
			)
			const state = await agenda.read()
			assert.ok(state)
			pursuit = state.pursuits[0]
			assert.ok(pursuit)
		}
		const writeMs = performance.now() - started
		const state = await agenda.read()
		assert.ok(state)
		await agenda.archive(state, { pursuitIds: [pursuit.id] })
		const archived = await agenda.read()
		assert.ok(archived)
		const source = new DiskResidentAgenda(root, scope).activity(archived.revision)
		const resolver = {
			maxReadBytes: 1,
			resolve: async (admission) => ({
				runId: admission.claimId,
				ownTokens: 100,
				treeTokens: 150,
				ownCostUsd: 0,
				unpricedOwnTokens: 100,
				usageFinal: true,
				cleanup: 'confirmed',
				verification: 'unconfigured',
			}),
		}
		const beginning = performance.now()
		const full = await inspectResidentConsumption(source, resolver, { maxRevisions: 4096 })
		const inspectMs = performance.now() - beginning
		assert.equal(full.historyComplete, true)
		assert.equal(full.attempts.length, steps)
		assert.equal(full.recorded.ownTokens, steps * 100)
		assert.equal(full.recorded.treeTokens, steps * 150)
		assert.equal(full.archivedPursuits.length, 1)
		const limited = await inspectResidentConsumption(source, resolver)
		assert.equal(limited.historyComplete, false)
		assert.equal(limited.nextCursor, 257)
		let cursor = 1
		const claims = new Set()
		let tokens = 0
		let pageBytes = 0
		let pages = 0
		const pagedStart = performance.now()
		while (cursor !== null) {
			const page = await inspectResidentConsumption(source, resolver, { cursor, maxRevisions: 128 })
			pages++
			assert.ok(pages <= 32)
			assert.ok(page.historyBytes <= 8 * 1024 * 1024)
			for (const attempt of page.attempts) {
				assert.ok(!claims.has(attempt.claimId))
				claims.add(attempt.claimId)
			}
			tokens += page.recorded.ownTokens
			pageBytes += page.historyBytes
			if (page.nextCursor !== null) assert.ok(page.nextCursor > cursor)
			cursor = page.nextCursor
		}
		assert.equal(claims.size, steps)
		assert.equal(tokens, full.recorded.ownTokens)
		const row = {
			steps,
			revisions: archived.revision,
			writeMs,
			inspectMs,
			pagedMs: performance.now() - pagedStart,
			pages,
			historyBytes: full.historyBytes,
			pageBytes,
			receiptBytesReserved: full.receiptBytesReserved,
			defaultInspectedAttempts: limited.attempts.length,
			ownTokens: tokens,
			treeTokens: full.recorded.treeTokens,
			approximateProcessRssBytes: process.memoryUsage().rss,
		}
		result.rows.push(row)
		await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
		console.log(JSON.stringify(row))
	}
	result.passed = true
} catch (error) {
	result.failure = error.stack
	process.exitCode = 1
} finally {
	result.endedAt = Date.now()
	result.buildAfter = await hashes()
	result.buildStable = JSON.stringify(result.buildBefore) === JSON.stringify(result.buildAfter)
	await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2) + '\n')
	console.log(
		JSON.stringify({ root, passed: result.passed ?? false, failure: result.failure ?? null }),
	)
}
