import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const digest = (text) => createHash('sha256').update(text).digest('hex')

function completion(finish, terminals, starts, sources) {
	assert.equal(finish.cleanup, 'confirmed')
	assert.equal(finish.error, null)
	assert.equal(finish.stopReason, 'end_turn')
	const terminal = terminals.find(
		(event) => event.runId === finish.runId && event.type === 'run_completed',
	)
	assert.ok(terminal, 'Missing matching completed run')
	assert.equal(terminal.stopReason, 'end_turn')
	assert.equal(digest(terminal.result), finish.verification.answerSha256)
	const answer = JSON.parse(terminal.result)
	assert.equal(answer.kind, 'complete')
	assert.equal(answer.summary.trim(), finish.decision.summary)
	const receipt = finish.verification.receipt
	assert.equal(receipt.runId, finish.runId)
	assert.deepEqual(answer.claims, receipt.claims)
	const scope = JSON.parse(receipt.scope)
	for (const key of ['runId', 'claimId', 'pursuitId', 'sessionId'])
		assert.equal(scope[key], finish[key])
	assert.ok(scope.tenantId && scope.projectId && Number.isSafeInteger(scope.revision))
	const start = starts.find((item) => item.claimId === finish.claimId)
	assert.ok(start)
	assert.equal(start.runId, finish.runId)
	assert.equal(receipt.observations.length, 1)
	const observed = receipt.observations[0]
	assert.equal(observed.source, 'package.json')
	assert.match(observed.requestId, /^[a-f0-9-]{36}$/)
	assert.ok(observed.observedAt >= start.startedAt && observed.observedAt <= finish.finishedAt)
	assert.equal(observed.sha256, digest(sources['package.json']))
	assert.equal(observed.bytes, Buffer.byteLength(sources['package.json']))
	assert.equal(receipt.claims.version, JSON.parse(sources['package.json']).version)
	assert.deepEqual(finish.verificationPolicy, {
		version: 1,
		claims: [{ id: 'version', source: 'package.json', pointer: '/version' }],
	})
}

export function auditVerification(report) {
	assert.equal(report.version, 1)
	assert.equal(report.baseline.currentDocument.version, '3.0.0')
	assert.equal(report.baseline.phase, 'complete')
	assert.ok(report.baseline.summary.includes('1.0.0'))
	let tokens = 0
	for (const trial of report.trials) {
		assert.equal(trial.failure, null)
		assert.deepEqual(trial.buildBefore, trial.buildAfter)
		if (trial.kind === 'cases') {
			for (const row of trial.cases) {
				assert.equal(row.finishes.length, 1)
				assert.equal(row.runs.length, 1)
				assert.equal(row.providerTokens, row.runs[0].tokenUsage.totalTokens)
				tokens += row.providerTokens
				const finish = row.finishes[0]
				assert.equal(finish.runId, row.runs[0].id)
				if (row.id === 'exhausted') {
					assert.equal(row.phase, 'running')
					assert.equal(finish.stopReason, 'answer_rejected')
					assert.equal(finish.decision, null)
					assert.equal(finish.verification, null)
				} else if (row.id === 'missing') {
					assert.equal(row.phase, 'blocked')
					assert.equal(finish.decision.kind, 'blocked')
					assert.equal(finish.verification, null)
				} else {
					assert.equal(row.phase, 'complete')
					completion(finish, row.terminals, row.starts, row.sources)
				}
				if (['repair', 'changed', 'exhausted'].includes(row.id))
					assert.ok(row.requests.some((r) => r.feedback.length > 0))
			}
		} else {
			assert.equal(trial.kind, 'continuity')
			assert.equal(trial.passed, true)
			assert.equal(trial.workerPids.length, 3)
			assert.equal(trial.finishes.length, 17)
			assert.equal(trial.runs.length, 17)
			assert.equal(new Set(trial.finishes.map((f) => f.claimId)).size, 17)
			assert.equal(trial.finishes.filter((f) => f.decision?.kind === 'wait').length, 14)
			const unfinished = trial.finishes.filter((f) => f.decision === null)
			assert.equal(unfinished.length, 1)
			assert.equal(unfinished[0].cleanup, 'confirmed')
			assert.equal(unfinished[0].verification, null)
			assert.equal(unfinished[0].usage, null) // cancellation is not fabricated zero usage
			assert.ok(unfinished[0].error)
			const completed = trial.finishes.filter((f) => f.decision?.kind === 'complete')
			assert.equal(completed.length, 2)
			for (const finish of completed)
				completion(finish, trial.terminals, trial.starts, trial.sources)
			for (let wave = 1; wave <= 6; wave++) {
				const deliveries = trial.requests.filter((r) => r.epoch === wave)
				assert.equal(deliveries.length, 2)
				assert.ok(deliveries.every((r) => r.waveMarkers.includes(`wave-${wave}`)))
			}
			if (trial.policySnapshotVerified)
				assert.equal(JSON.parse(trial.sources['checks.json']).version, 999)
			assert.equal(trial.providerTokens, 0)
		}
	}
	assert.equal(tokens, report.providerTokens)
	return { trials: report.trials.length, liveTokens: tokens }
}
