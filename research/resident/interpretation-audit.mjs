import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { cases, objective } from './interpretation-cases.mjs'

// Validate observations independently of the driver's pass flag. This checks
// delivery, ownership and reported usage, never substitutes for reading answers.
export function auditTrial(trial) {
	assert.deepEqual(trial.buildBefore, trial.buildAfter)
	let total = 0
	for (const row of trial.cases) {
		const fixture = cases.find((item) => item.id === row.id)
		assert.ok(fixture)
		assert.equal(row.error, undefined)
		assert.equal(row.seed.length, 2)
		assert.equal(new Set(row.seed.map((seed) => seed.start.sessionId)).size, 2)
		assert.equal(row.finishes.length, 3)
		assert.equal(new Set(row.finishes.map((finish) => finish.sessionId)).size, 3)
		assert.ok(
			row.finishes.every(
				(finish) =>
					finish.cleanup === 'confirmed' && finish.stopReason === 'end_turn' && !finish.error,
			),
		)
		const archive = new Map(row.seed.map((seed) => [seed.start.sessionId, seed]))
		const first = row.requests[0]
		assert.ok(first)
		assert.ok(
			!JSON.stringify(first).includes('CD-3964') && !JSON.stringify(first).includes('JP-8527'),
		)
		for (const request of row.requests) {
			assert.equal(request.evidence.length, 1)
			const block = request.evidence[0]
			assert.ok(block.slice(block.indexOf('Retrieved resident evidence')).length <= 6000)
			const objects = block
				.split('\n')
				.filter((line) => line.startsWith('{'))
				.map(JSON.parse)
			const receipt = objects.find((item) => item.querySelection)
			assert.ok(receipt)
			assert.ok(
				Number.isSafeInteger(receipt.scannedBytes) &&
					receipt.scannedBytes >= 0 &&
					receipt.scannedBytes <= 8 * 1024 * 1024,
			)
			assert.ok(receipt.querySelection.terms.length <= 16)
			const observations = objects.filter((item) => item.sessionId)
			assert.equal(observations.length, 2)
			assert.equal(new Set(observations.map((item) => item.sessionId)).size, 2)
			for (const observation of observations) {
				const seed = archive.get(observation.sessionId)
				assert.ok(seed)
				for (const field of ['runId', 'claimId', 'pursuitId'])
					assert.equal(observation[field], seed.start[field])
				assert.equal(observation.revision, seed.revision)
				assert.ok(observation.revision <= receipt.querySelection.throughRevision)
				assert.equal(observation.isError, false)
				assert.equal(observation.retained, 'full')
				assert.equal(observation.recordKind, 'tool_result')
				assert.equal(observation.toolName, 'read')
				assert.ok(seed.observation.includes(observation.excerpt))
			}
			const snapshot = request.continuation
				.flatMap((text) =>
					text
						.split('\n')
						.filter((line) => line.startsWith('{'))
						.map(JSON.parse),
				)
				.find((value) => value.objective)
			assert.ok(snapshot)
			assert.equal(snapshot.objective, objective)
			assert.equal(snapshot.admission, 3)
			assert.deepEqual(
				snapshot.wakeEvidence.map((wake) => wake.reason),
				fixture.wakes,
			)
			assert.equal(snapshot.history.throughRevision, receipt.querySelection.throughRevision)
			assert.ok(observations.every((record) => record.pursuitId === snapshot.history.pursuitId))
		}
		assert.ok(
			row.answerTools.every((tool) =>
				[
					'read',
					'glob',
					'grep',
					'search_resident_tools',
					'read_resident_tool',
					'search_resident_history',
					'read_resident_history',
				].includes(tool.name),
			),
		)
		const tokens = row.runs.reduce((sum, run) => sum + (run.tokenUsage?.totalTokens ?? 0), 0)
		assert.equal(row.providerTokens, tokens)
		assert.ok(trial.live || tokens === 0)
		total += tokens
	}
	assert.equal(trial.providerTokens, total)
	return { cases: trial.cases.length, providerTokens: total }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const report = JSON.parse(await readFile(process.argv[2], 'utf8'))
	const trials = report.trials ?? [report]
	const results = trials.map(auditTrial)
	console.log(
		JSON.stringify({
			trials: results.length,
			cases: results.reduce((n, r) => n + r.cases, 0),
			providerTokens: results.reduce((n, r) => n + r.providerTokens, 0),
		}),
	)
}
